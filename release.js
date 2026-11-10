// npm run release: bumps the version, commits and tags it, pushes, then builds the installer and
// publishes it as a GitHub release. Installed copies see it within a minute. Needs `gh auth login` once.
const { execSync } = require('child_process');

const run = (cmd, env) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
const token = execSync('gh auth token').toString().trim();
run('npm test');
run('npm version patch --no-git-tag-version'); // installed apps only update to a higher version
const version = require('./package.json').version;
run('git add -A');
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`); // GitHub refuses to publish a release without an existing tag
run('git push --follow-tags origin main');
run('npx electron-builder --win --publish always', { GH_TOKEN: token });
console.log(`\nReleased v${version}`);
