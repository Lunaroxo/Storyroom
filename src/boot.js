'use strict';
function newProject() {
  return {
    version: 1,
    show: { title: 'Untitled Show', logline: '', genre: '', audience: '', rating: '', runtime: '', planned: '', style: '', bible: '<p><br></p>' },
    episodes: [newEpisode('Pilot')],
    pages: [],
    columns: ['Ideas', 'Writing', 'Storyboard', 'Animatic', 'Animation', 'Sound', 'Done'].map((name) => ({ id: uid(), name })),
    tasks: [],
    library: { folders: ['Theme Songs', 'Background Music', 'Foley', 'Ambience'], items: [] },
    sources: [],
    todos: [],
  };
}

// Brings shows saved by older versions up to the current shape.
function upgrade(project) {
  const parts = (list) => list.forEach((p) => { p.children ||= []; p.open ??= true; parts(p.children); });
  project.episodes.forEach((e) => parts(e.parts));
  project.todos ||= [];
  return project;
}

(async () => {
  const { rootUrl, data } = await api['project:load']();
  // Saved documents use paths relative to the show folder, so a show can be moved or backed up whole.
  document.head.prepend(h('base', { href: rootUrl }));
  S = upgrade(data || newProject());
  buildRail();
  buildPlayer();
  api.onDownload(onDownloadUpdate, onDownloadDone);
  api.onResults(onSearchResults);
  api.onUpdate((version) => {
    if ($('.toast.update')) return;
    $('#toasts').append(h('div', { class: 'toast update' }, `Storyroom ${version} is ready. `,
      btn('Restart to update', () => { saveNow(); api['update:install'](); }, 'primary'),
      btn('Later', (e) => e.target.parentElement.remove())));
  });
  if (!data) touch();
  go('writing');
})();
