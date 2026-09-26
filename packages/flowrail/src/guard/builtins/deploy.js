// Changes to shared systems: publish-deploy (packages, releases, merges, deploys),
// infra-destructive (kubectl delete, terraform destroy, aws s3 rm --recursive) and db-destructive
// (DROP, TRUNCATE, DELETE without WHERE, prisma migrate reset). Part of the vendored guard.
import { hold, has, positionals, eachCommand } from './common.js';

const GH_API_WRITE = new RegExp('^(-X|--method)(=?(PUT|POST))?$|^-X(PUT|POST)$'
  + '|^(-f|-F|--field|--raw-field|--input)$', 'i');
const MERGE_API = /(^|\/)repos\/[^/\s]+\/[^/\s]+\/(pulls\/\d+\/merge|merges)(\?|$)/;

function publishArgv(argv) {
  const [bin, a1, a2] = argv;
  const pos = positionals(argv.slice(1));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
    if (pos[0] === 'publish') return `${bin} publish`;
    // yarn 2+: yarn npm publish; yarn workspaces foreach ... npm publish
    if (bin === 'yarn' && pos.some((p, i) => p === 'npm' && pos[i + 1] === 'publish')) {
      return 'yarn npm publish';
    }
    if (pos[0] === 'run' && /^(deploy|release|publish|ship)/.test(pos[1] || '')) {
      return `${bin} run ${pos[1]}`;
    }
    return null;
  }
  if (bin === 'gh') {
    if (a1 === 'pr' && a2 === 'merge') return 'gh pr merge';
    if (a1 === 'release' && ['create', 'delete', 'upload', 'edit'].includes(a2)) {
      return `gh release ${a2}`;
    }
    if (a1 === 'repo' && ['delete', 'archive', 'rename', 'edit'].includes(a2)) {
      return `gh repo ${a2}`;
    }
    if (a1 === 'workflow' && a2 === 'run') return 'gh workflow run';
    // gh api -X PUT repos/o/r/pulls/1/merge: the merge button through the REST API.
    // gh api sends GET unless given a method or fields (-f, -F, --input), which make it POST.
    const writes = argv.some((a) => GH_API_WRITE.test(a));
    if (a1 === 'api' && writes && argv.some((a) => MERGE_API.test(a))) return 'gh api .../merge';
    return null;
  }
  if (['curl', 'wget', 'http', 'https', 'xh'].includes(bin) && argv.some((a) => MERGE_API.test(a))
    && argv.some((a) => /^(-X|--request)$|^-X(PUT|POST)$|^(PUT|POST)$/i.test(a))) {
    return 'a merge through the GitHub API';
  }
  if (['make', 'just', 'task'].includes(bin)) {
    const target = pos.find((p) => /^(deploy|release|publish|ship)([-_:].*)?$/.test(p));
    return target ? `${bin} ${target}` : null;
  }
  const simple = { cargo: 'publish', twine: 'upload', gem: 'push', poetry: 'publish' };
  if (simple[bin] && a1 === simple[bin]) return `${bin} ${a1}`;
  if (bin === 'docker' && (a1 === 'push' || (a1 === 'image' && a2 === 'push'))) {
    return 'docker push';
  }
  if (bin === 'vercel' && (has(argv, '--prod') || ['promote', 'rollback'].includes(a1))) {
    return 'vercel production deploy';
  }
  if (bin === 'netlify' && a1 === 'deploy' && has(argv, '--prod')) return 'netlify deploy --prod';
  if (['fly', 'flyctl'].includes(bin) && a1 === 'deploy') return 'fly deploy';
  if (bin === 'wrangler' && ['deploy', 'publish'].includes(a1)) return `wrangler ${a1}`;
  if (bin === 'firebase' && a1 === 'deploy') return 'firebase deploy';
  if (bin === 'kubectl' && ['apply', 'rollout', 'delete', 'replace', 'scale'].includes(a1)) {
    return `kubectl ${a1}`;
  }
  if (['terraform', 'tofu'].includes(bin) && ['apply', 'destroy'].includes(a1)) {
    return `${bin} ${a1}`;
  }
  if (bin === 'helm' && ['install', 'upgrade', 'uninstall', 'rollback'].includes(a1)) {
    return `helm ${a1}`;
  }
  const deployers = ['serverless', 'sls', 'cdk', 'eas', 'railway', 'amplify'];
  if (deployers.includes(bin) && ['deploy', 'submit', 'up', 'publish'].includes(a1)) {
    return `${bin} ${a1}`;
  }
  if (bin === 'pulumi' && ['up', 'destroy'].includes(a1)) return `pulumi ${a1}`;
  if (['gcloud', 'aws', 'az'].includes(bin) && pos.includes('deploy')) return `${bin} ... deploy`;
  if (bin === 'heroku' && /^(releases:rollback|container:release)$/.test(a1 || '')) {
    return `heroku ${a1}`;
  }
  return null;
}

export function publishDeploy(ctx) {
  if (ctx.tool !== 'Bash') return null;
  return eachCommand(ctx, ({ argv }) => {
    const what = publishArgv(argv);
    return what ? hold('block', what) : null;
  });
}

// ---------- infrastructure ----------

const KUBE_VERBS = new Set(('get describe create apply delete drain edit patch replace scale '
  + 'rollout logs exec port-forward label annotate cordon uncordon taint expose run set top '
  + 'config cp auth wait diff explain api-resources version cluster-info').split(' '));
// Options that take a value, so the value is not taken for a subcommand.
const VALUE_OPTS = new Set(['--profile', '--region', '--endpoint-url', '--output', '--context',
  '--namespace', '-n', '--kubeconfig', '--project', '--subscription', '--cluster', '--query']);

function operands(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (VALUE_OPTS.has(argv[i])) { i++; continue; }
    if (!argv[i].startsWith('-')) out.push(argv[i]);
  }
  return out;
}

function infraArgv(argv) {
  const [bin, a1] = argv;
  const pos = operands(argv);
  if (bin === 'kubectl') {
    const verb = pos.find((p) => KUBE_VERBS.has(p));
    return verb === 'delete' || verb === 'drain' ? `kubectl ${verb}` : null;
  }
  if (['terraform', 'tofu'].includes(bin)) {
    if (pos[0] === 'destroy') return `${bin} destroy`;
    const auto = argv.some((a) => /^--?auto-approve(=true)?$/.test(a));
    if (pos[0] === 'apply' && (auto || has(argv, '-destroy'))) return `${bin} apply -auto-approve`;
    if (pos[0] === 'state' && ['rm', 'push'].includes(pos[1])) return `${bin} state ${pos[1]}`;
    return null;
  }
  if (bin === 'aws') {
    if (pos[0] === 's3' && pos[1] === 'rm' && has(argv, '--recursive')) {
      return 'aws s3 rm --recursive';
    }
    if (pos[0] === 's3' && pos[1] === 'rb' && has(argv, '--force')) return 'aws s3 rb --force';
    if (pos[0] === 's3' && pos[1] === 'sync' && has(argv, '--delete')) {
      return 'aws s3 sync --delete';
    }
    const verb = pos[1] || '';
    if (/^(delete|terminate|remove|deregister|purge)-/.test(verb) || verb === 'delete') {
      return `aws ${pos[0]} ${verb}`;
    }
    return null;
  }
  if (bin === 'gcloud' || bin === 'az' || bin === 'doctl') {
    return pos.includes('delete') || pos.includes('destroy') ? `${bin} ... delete` : null;
  }
  if (bin === 'gsutil' && (pos[0] === 'rm' && /r/i.test(argv.join(' ')) || pos[0] === 'rb')) {
    return `gsutil ${pos[0]}`;
  }
  if (bin === 'helm' && ['uninstall', 'delete'].includes(a1)) return `helm ${a1}`;
  if (bin === 'pulumi' && a1 === 'destroy') return 'pulumi destroy';
  if (['fly', 'flyctl'].includes(bin)
    && (a1 === 'destroy' || (pos[0] === 'apps' && pos[1] === 'destroy'))) {
    return 'fly destroy';
  }
  if (bin === 'heroku' && /^(apps:destroy|pg:reset)$/.test(a1 || '')) return `heroku ${a1}`;
  const volume = a1 === 'volume' && ['rm', 'prune'].includes(argv[2]);
  if (bin === 'docker' && (volume || (a1 === 'system' && argv[2] === 'prune'))) {
    return `docker ${a1} ${argv[2]}`;
  }
  return null;
}

export function infraDestructive(ctx) {
  if (ctx.tool !== 'Bash') return null;
  return eachCommand(ctx, ({ argv }) => {
    const what = infraArgv(argv);
    return what ? hold('block', what) : null;
  });
}

// ---------- databases ----------

const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'mongosh', 'mongo',
  'cockroach', 'clickhouse-client', 'sqlcmd', 'duckdb', 'redis-cli', 'pgcli', 'mycli']);
const SQL = new RegExp('\\b(drop\\s+(table|database|schema|collection)\\b'
  + '|truncate(\\s+table)?\\s+\\w|dropDatabase\\s*\\(|\\.drop\\s*\\(|flushall\\b|flushdb\\b)', 'i');

/** DELETE FROM x with no WHERE: every row. */
const deleteAll = (text) => /\bdelete\s+from\s+[\w."`]+\s*(;|$|\)|"|')/im.test(text);

function dbArgv(cmd, next) {
  const { argv, redirects } = cmd;
  const [bin, a1, a2] = argv;
  if (bin === 'prisma' && ((a1 === 'migrate' && a2 === 'reset') || (a1 === 'db' && a2 === 'push'
    && has(argv, '--force-reset', '--accept-data-loss')))) return `prisma ${a1} ${a2}`;
  if (['rails', 'rake', 'bin/rails'].includes(bin)
    && /^db:(drop|reset|schema:load|purge|truncate_all)/.test(a1 || '')) {
    return `${bin} ${a1}`;
  }
  if (bin === 'dropdb') return 'dropdb';
  const django = /manage\.py$/.test(a1 || '') && /^(flush|reset_db|sqlflush)$/.test(a2 || '');
  if (['python', 'python3'].includes(bin) && django) {
    return `manage.py ${a2}`;
  }
  if (['npx', 'bunx', 'pnpx'].includes(bin) && a1 === 'prisma') {
    return dbArgv({ argv: argv.slice(1), redirects }, next);
  }
  const texts = [];
  if (DB_CLIENTS.has(bin)) {
    texts.push(argv.slice(1).join(' '));
    for (const r of redirects) if (r.body || r.op === '<<<') texts.push(r.body ?? r.target);
  }
  // echo "DROP TABLE users" | psql
  const feeds = ['echo', 'printf', 'cat'].includes(bin);
  if (cmd.sep === '|' && next && DB_CLIENTS.has(next.argv[0]) && feeds) {
    texts.push(argv.slice(1).join(' '), ...redirects.filter((r) => r.body).map((r) => r.body));
  }
  for (const t of texts) {
    const m = SQL.exec(t);
    if (m) {
      return `${feeds ? next.argv[0] : bin}: ${m[0].replace(/\s+/g, ' ')}`;
    }
    if (deleteAll(t) && !/\bwhere\b/i.test(t)) return `${bin}: DELETE without WHERE`;
  }
  return null;
}

export function dbDestructive(ctx) {
  if (ctx.tool !== 'Bash') return null;
  return eachCommand(ctx, (cmd, _cwd, i) => {
    const what = dbArgv(cmd, ctx.cmds[i + 1]);
    return what ? hold('block', what) : null;
  });
}
