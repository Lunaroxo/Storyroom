// npm run release: bumps the version, builds the installer and publishes it as a GitHub release.
// Installed copies see the new release within a minute. Needs `gh auth login` once.
const { execSync } = require('child_process');

const run = (cmd, env) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
const token = execSync('gh auth token').toString().trim();
run('npm test');
run('npm version patch --no-git-tag-version'); // installed apps only update to a higher version
run('npx electron-builder --win --publish always', { GH_TOKEN: token });
console.log(`\nReleased v${require('./package.json').version}`);
