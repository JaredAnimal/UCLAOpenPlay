import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const branch = 'refs/heads/gh-pages';
const previous = git('ls-remote', 'origin', branch).split(/\s/)[0];
const tree = git('rev-parse', 'HEAD:public');
if (previous) {
  git('fetch', 'origin', branch);
  if (git('rev-parse', `${previous}^{tree}`) === tree) {
    console.log('The Pages branch already has this frontend.');
    process.exit(0);
  }
}
const parent = previous ? ['-p', previous] : [];
const commit = git('commit-tree', tree, ...parent, '-m', `Publish Open Play frontend from ${git('rev-parse', '--short', 'HEAD')}`);
execFileSync('git', ['push', 'origin', `${commit}:${branch}`], { stdio: 'inherit' });
