// Actions in the world: MCP tools that send, merge, delete or change what other people see
// (mcp-actions), email (email-send) and payments (payments). Part of the vendored guard.
import os from 'node:os';
import {
  hold, mcpName, words, eachCommand, positionals, mcpWrites, inputPaths, resolveWord, realPath,
  inside, toPosix,
} from './common.js';
import { mcpRepoWrite } from './git.js';

const MCP_ACT = new RegExp('^(send|post|publish|push|merge|delete|remove|trash|create_release'
  + '|release|deploy|transfer|pay|charge|refund|invite|share|forward|reply|submit|approve|close'
  + '|archive|drop)$');
const MCP_READ = new RegExp('^(get|list|search|read|fetch|find|query|describe|show|view|check'
  + '|download|count|lookup)$');
// Other people see it: an invite from a calendar event, a changed shared doc, a new permission,
// a comment. Drafts stay allowed.
const CALENDAR = /calendar|\bcal\b|outlook|calendly|zoom|meet/i;
const EVENT = /^(events?|meetings?|invites?|invitations?|bookings?)$/;
const EVENT_VERB = /^(create|update|move|delete|cancel|respond|reschedule|add|patch|quick)$/;
const DOCS = new RegExp('notion|confluence|docs|drive|sheets|slides|coda|quip|sharepoint'
  + '|onedrive|dropbox|box|airtable|wiki', 'i');
const DOC = new RegExp('^(pages?|docs?|documents?|blocks?|databases?|files?|sheets?|spreadsheets?'
  + '|slides?|presentations?|folders?|rows?|records?|views?|content|cells?|values?)$');
const DOC_VERB = new RegExp('^(create|update|append|replace|duplicate|insert|edit|write'
  + '|rename|upload|copy|batch|move)$');
const PERMISSION = /^(permissions?|access|sharing|collaborators?|members?)$/;
const COMMENT = /^(comments?)$/;
const ADD = /^(create|add|post|update|reply|insert)$/;

/** Why an MCP tool changes something other people see, or null. */
function externalEffect(server, w) {
  if (w.some((x) => /^drafts?$/.test(x)) && !w.includes('send')) return null;
  const head = w.slice(0, 3);
  if (CALENDAR.test(server + ' ' + w.join(' ')) && head.some((x) => EVENT_VERB.test(x))
    && w.some((x) => EVENT.test(x))) return 'a calendar event (invites go out)';
  if (w.some((x) => PERMISSION.test(x)) && head.some((x) => ADD.test(x) || x === 'grant')) {
    return 'sharing (a new permission)';
  }
  if (w.some((x) => COMMENT.test(x)) && head.some((x) => ADD.test(x))) {
    return 'a comment others see';
  }
  if (DOCS.test(server + ' ' + w[0]) && head.some((x) => DOC_VERB.test(x))
    && w.some((x) => DOC.test(x))) return 'a change to a shared document';
  return null;
}

const TMP = [...new Set(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders',
  toPosix(os.tmpdir())])];

/**
 * A local filesystem MCP tool (write_file, edit_file, move_file, create_directory) on a path
 * outside the project and outside the temp folders: Claude Code asks before Write outside the
 * project, but not before an MCP server's writes, so this red line does.
 */
const LOCAL_FS = /filesystem|(^|[_-])fs($|[_-])|desktop[_-]?commander|local[_-]?files?/i;

function outsideWrite(ctx, m) {
  // Cloud storage servers (Drive, Dropbox) take paths in their own namespace: not this folder.
  if (!LOCAL_FS.test(m.server) || !mcpWrites(m.tool)) return null;
  const roots = ctx.roots && ctx.roots.length ? ctx.roots : [ctx.root];
  for (const f of inputPaths(ctx.input)) {
    const abs = resolveWord(f, ctx.cwd || ctx.root);
    if (!abs) return `${m.tool} on a path set by a variable`;
    const real = realPath(abs, { follow: true });
    const ok = (x) => roots.some((r) => inside(x, r)) || TMP.some((t) => inside(x, t) && x !== t);
    if (!ok(abs) || !ok(real)) return `${m.tool} outside the project (${f})`;
  }
  return null;
}

/** send/post/push/merge/delete/pay/... tools on any MCP server, and changes others see. */
export function mcpActions(ctx) {
  const m = mcpName(ctx.tool);
  if (!m) return null;
  const repo = mcpRepoWrite(ctx.tool);
  if (repo) return hold('block', repo);
  const outside = outsideWrite(ctx, m);
  if (outside) return hold('block', outside);
  const w = words(m.tool);
  if (!w.length || MCP_READ.test(w[0])) return null;
  const hit = MCP_ACT.test(w[0]) || MCP_ACT.test(w.slice(0, 2).join('_'))
    || (w[1] && MCP_ACT.test(w[1]));
  if (hit) return hold('block', `${m.server}: ${m.tool}`);
  const effect = externalEffect(m.server, w);
  return effect ? hold('block', `${m.server}: ${m.tool}, ${effect}`) : null;
}

// ---------- email ----------

const MAIL_SERVER = new RegExp('mail|smtp|outlook|sendgrid|postmark|resend|mailgun|mailchimp'
  + '|\\bses\\b|brevo|sparkpost', 'i');
const MAIL_BINS = new Set(['sendmail', 'mail', 'mailx', 'mutt', 'msmtp', 'swaks', 'neomutt']);
const MAIL_API = new RegExp('/v3/mail/send|api\\.postmarkapp\\.com/email'
  + '|api\\.resend\\.com/emails|mailgun\\.net/v3/\\S+/messages|email\\.[\\w-]+\\.amazonaws\\.com'
  + '|api\\.brevo\\.com/v3/smtp', 'i');

/** Email: sendmail, mutt, swaks, a mail API, and send/forward/reply tools on mail MCP servers. */
export function emailSend(ctx) {
  const m = mcpName(ctx.tool);
  if (m) {
    const w = words(m.tool);
    const mailish = MAIL_SERVER.test(m.server) || w.some((x) => /^e?mails?$/.test(x));
    const sends = w.some((x) => /^(send|forward|reply|resend)$/.test(x));
    const reads = /^(get|list|search|read)$/.test(w[0]);
    return mailish && sends && !reads ? hold('block', `${m.server}: ${m.tool}`) : null;
  }
  if (ctx.tool !== 'Bash') return null;
  return eachCommand(ctx, ({ argv }) => {
    const [bin] = argv;
    if (MAIL_BINS.has(bin)) return hold('block', bin);
    const [svc, verb] = positionals(argv.slice(1));
    if (bin === 'aws' && svc === 'ses' && /^send/.test(verb || '')) {
      return hold('block', 'aws ses send');
    }
    if (['curl', 'wget', 'http', 'https', 'xh'].includes(bin) && MAIL_API.test(argv.join(' '))) {
      return hold('block', 'a mail API call');
    }
    return null;
  });
}

// ---------- payments ----------

const PAY_SERVER = new RegExp('stripe|paypal|braintree|adyen|square|mollie|paddle|lemon|checkout'
  + '|revolut|wise|payment|billing|chargebee|recurly', 'i');
const MONEY = /^(charges?|refunds?|payouts?|transfers?|pay|capture|refund)$/;
// finalize_invoice emails it, update_subscription changes what a customer pays, void cancels.
const PAY_VERB = new RegExp('^(send|cancel|void|finalize|update|delete|pay|capture|resume|pause'
  + '|apply|mark|close|accept|archive|deactivate)$');
const PAY_OBJECT = new RegExp('^(charges?|refunds?|payouts?|transfers?|payments?|invoices?'
  + '|subscriptions?|intents?|money|orders?|credits?|coupons?|discounts?|prices?|plans?|disputes?'
  + '|promotion|products?|balances?)$');
// Creating these moves money or changes what customers are billed (a coupon, a price, a plan);
// creating an invoice, a customer or a draft only makes a record.
const CREATE_MONEY = new RegExp('^(charges?|refunds?|payouts?|transfers?|payments?|intents?'
  + '|subscriptions?|orders?|coupons?|discounts?|prices?|plans?|promotion|links?)$');
const BILLING = /^(coupons?|discounts?|prices?|plans?|promotion|disputes?|products?|links?)$/;
const STRIPE_API = new RegExp('api\\.stripe\\.com/v1/(charges|refunds|payouts|transfers'
  + '|payment_intents|invoices/\\w+/pay)');
const STRIPE_OBJECTS = /^(charges|refunds|payouts|transfers|payment_intents|invoices)$/;

/** Payments: tools on payment MCP servers that move money, and the Stripe CLI and API. */
export function payments(ctx) {
  const m = mcpName(ctx.tool);
  if (m) {
    if (!PAY_SERVER.test(m.server)) return null;
    const w = words(m.tool);
    const money = w.some((x) => MONEY.test(x))
      || (PAY_VERB.test(w[0]) && w.slice(1).some((x) => PAY_OBJECT.test(x)))
      || (w[0] === 'create' && w.slice(1).some((x) => CREATE_MONEY.test(x)));
    const reads = /^(get|list|search|retrieve|read)$/.test(w[0]);
    if (!money || reads) return null;
    // Billing changes (a coupon, a price, a plan, a dispute answer) change what customers pay
    // later: asked. Moving money now is blocked.
    const billing = !w.some((x) => MONEY.test(x) || /^(invoices?|intents?)$/.test(x))
      && w.slice(1).some((x) => BILLING.test(x));
    return billing ? hold('ask', `${m.server}: ${m.tool} (a billing change)`)
      : hold('block', `${m.server}: ${m.tool}`);
  }
  if (ctx.tool !== 'Bash') return null;
  return eachCommand(ctx, ({ argv }) => {
    const [bin, a1, a2] = argv;
    const moves = STRIPE_OBJECTS.test(a1 || '') && /^(create|capture|pay|confirm)$/.test(a2 || '');
    if (bin === 'stripe' && moves) return hold('block', `stripe ${a1} ${a2}`);
    if (['curl', 'wget', 'http', 'https', 'xh'].includes(bin) && STRIPE_API.test(argv.join(' '))) {
      const post = argv.includes('-X')
        || argv.some((a) => /^(-d|--data.*|-F|--form|-XPOST|POST)$/.test(a));
      return post ? hold('block', 'a Stripe API call that moves money') : null;
    }
    return null;
  });
}
