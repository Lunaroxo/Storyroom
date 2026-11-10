// One search per site. Each extract function runs inside that site's search page, in a hidden
// window, and returns [{title, artist, audio, page, duration, license}]. Sites change their pages,
// so an extractor can break; its source then simply returns no results.
// `audio` is a direct file. Results with only `page` are fetched with yt-dlp.

const mixkit = function () {
  return [...document.querySelectorAll('[data-audio-player-preview-url-value*="assets.mixkit"]')].map((e) => {
    const card = e.closest('.item-grid-card');
    const time = card?.innerText.match(/\b(\d+):(\d\d)\b/);
    return { title: card?.querySelector('h2')?.textContent.trim(), audio: e.getAttribute('data-audio-player-preview-url-value'), page: location.href, duration: time ? +time[1] * 60 + +time[2] : 0 };
  });
};

const pixabay = function () {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (!Array.isArray(o) && o.name && o.href && o.duration != null) {
      const text = JSON.stringify(o);
      const audio = text.match(/https:[^"]*?\.mp3/);
      if (audio) out.push({ title: o.name, artist: (o.attributionHtml || '').match(/>([^<]+)<\/a> from/)?.[1], audio: audio[0], page: `https://pixabay.com${o.href}`, duration: o.duration });
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(window.__BOOTSTRAP__);
  return out;
};

module.exports = [
  { name: 'Pixabay Sounds', license: 'Pixabay Content License', url: (s) => `https://pixabay.com/sound-effects/search/${s}/`, extract: pixabay },
  { name: 'Pixabay Music', license: 'Pixabay Content License', url: (s) => `https://pixabay.com/music/search/${s}/`, extract: pixabay },
  { name: 'Mixkit Sounds', license: 'Mixkit License', url: (s) => `https://mixkit.co/free-sound-effects/${s}/`, extract: mixkit },
  { name: 'Mixkit Music', license: 'Mixkit License', url: (s) => `https://mixkit.co/free-stock-music/tag/${s}/`, extract: mixkit },
  {
    name: 'Freesound', url: (s) => `https://freesound.org/search/?q=${s}`,
    extract: function () {
      return [...document.querySelectorAll('.bw-search__result')].map((r) => {
        const p = r.querySelector('[data-mp3]');
        return p && { title: p.dataset.title, artist: p.dataset.username, audio: p.dataset.mp3.replace('-lq.', '-hq.'), page: `https://freesound.org/people/${p.dataset.username}/sounds/${p.dataset.soundId}/`, duration: +p.dataset.duration, license: r.querySelector('[title^="License"]')?.title.replace('License: ', '').replace(/^(?!Creative)/, 'Creative Commons ') };
      });
    },
  },
  {
    name: 'Openverse', url: (s) => `https://api.openverse.org/v1/audio/?q=${s}&page_size=20&format=json`,
    extract: function () {
      return JSON.parse(document.body.innerText).results.map((r) => ({ title: r.title, artist: r.creator, audio: r.url, page: r.foreign_landing_url, duration: (r.duration || 0) / 1000, license: `CC ${r.license.toUpperCase()} ${r.license_version || ''}`.trim() }));
    },
  },
  {
    name: 'BBC Sound Effects', license: 'BBC RemArc: personal and educational use only', url: (s) => `https://sound-effects.bbcrewind.co.uk/search?q=${s}`,
    extract: function () {
      return [...document.querySelectorAll('audio[src*="bbcrewind"]')].map((a) => {
        let row = a;
        for (let i = 0; i < 9 && row.innerText.length < 40; i++) row = row.parentElement;
        const lines = row.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
        const time = lines.find((l) => /^\d+:\d\d$/.test(l))?.split(':');
        return { title: lines.find((l) => !/^\d+:\d\d$/.test(l)), audio: a.src, page: location.href, duration: time ? +time[0] * 60 + +time[1] : 0 };
      });
    },
  },
  {
    name: 'SoundBible', license: 'See SoundBible page', url: (s) => `https://soundbible.com/search.php?q=${s}`,
    extract: function () {
      return [...document.querySelectorAll('audio source[src*=".mp3"]')].map((a) => ({ title: decodeURIComponent(a.src.split('/').pop()).replace(/-SoundBible.*|-[^-]*-\d+\.mp3$|\.mp3$/g, '').replace(/_/g, ' '), audio: a.src, page: location.href }));
    },
  },
  {
    name: 'MyInstants', license: 'Unknown: check before using', url: (s) => `https://www.myinstants.com/en/search/?name=${s}`,
    extract: function () {
      return [...document.querySelectorAll('[onclick^="share("]')].map((b) => {
        const m = b.getAttribute('onclick').match(/^share\('(.*)', '(.*?)', '(.*?)', '.*?'\)$/);
        return m && { title: m[1].replace(/\\'/g, "'"), page: m[2], audio: new URL(m[3], location.href).href };
      });
    },
  },
  {
    name: 'Free Music Archive', license: 'See Free Music Archive page', url: (s) => `https://freemusicarchive.org/search?quicksearch=${s}`,
    extract: function () {
      return [...document.querySelectorAll('[data-track-info]')].map((e) => {
        const t = JSON.parse(e.getAttribute('data-track-info'));
        return { title: t.title, artist: t.artistName, audio: t.playbackUrl, page: t.url };
      });
    },
  },
  {
    name: 'YouTube', license: 'Unknown: check before using', url: (s) => `https://www.youtube.com/results?search_query=${s}`,
    extract: function () {
      const out = [];
      const secs = (t) => (t || '').split(':').reduce((n, x) => n * 60 + +x, 0);
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 40) return;
        if (o.videoRenderer?.videoId) {
          const v = o.videoRenderer;
          out.push({ title: v.title?.runs?.[0]?.text, artist: v.ownerText?.runs?.[0]?.text, page: `https://www.youtube.com/watch?v=${v.videoId}`, duration: secs(v.lengthText?.simpleText) });
        } else if (o.lockupViewModel?.contentId && /VIDEO/.test(o.lockupViewModel.contentType || '')) {
          const l = o.lockupViewModel;
          out.push({ title: l.metadata?.lockupMetadataViewModel?.title?.content, page: `https://www.youtube.com/watch?v=${l.contentId}` });
        }
        Object.values(o).forEach((x) => walk(x, depth + 1));
      };
      walk(window.ytInitialData, 0);
      return out;
    },
  },
  {
    name: 'SoundCloud', license: 'Unknown: check before using', url: (s) => `https://soundcloud.com/search/sounds?q=${s}`,
    extract: function () {
      return [...document.querySelectorAll('.searchItem, .sound__body')].map((r) => {
        const a = r.querySelector('.soundTitle__title');
        return a && { title: a.textContent.trim(), artist: r.querySelector('.soundTitle__username')?.textContent.trim(), page: a.href };
      });
    },
  },
  {
    name: 'Internet Archive', license: 'See Internet Archive page', url: (s) => `https://archive.org/advancedsearch.php?q=title%3A${s}+AND+mediatype%3Aaudio&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=15&output=json`,
    extract: function () {
      return JSON.parse(document.body.innerText).response.docs.map((d) => ({ title: d.title, artist: [].concat(d.creator || '')[0], page: `https://archive.org/details/${d.identifier}` }));
    },
  },
];
