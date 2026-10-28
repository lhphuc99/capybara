// Pushes the tags `changeset publish` just made (name@version), and only those: a Dart package's tag starts its
// publishing to pub.dev, so `git push --tags` must not carry one along.
import { execFileSync } from 'node:child_process';

const tags = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', '*@*'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
if (tags.length === 0) {
  console.log('No package tags at HEAD to push.');
} else {
  execFileSync('git', ['push', 'origin', ...tags.map((tag) => `refs/tags/${tag}`)], { stdio: 'inherit' });
}
