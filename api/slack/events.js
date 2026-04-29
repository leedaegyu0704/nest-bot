import crypto from 'node:crypto';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

async function postSlackThinking(channel, threadTs) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text: '🤔 생각 중...',
      }),
    });
  } catch (err) {
    console.error('postSlackThinking error', err);
  }
}

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function verifySlackSignature(rawBody, timestamp, signature) {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ghHeaders = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

async function findIssueByThread(threadTs) {
  const q = `repo:${GITHUB_REPO} in:title "[Slack:${threadTs}]" is:issue`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  const data = await res.json();
  return data.items?.[0]?.number ?? null;
}

async function createIssue(threadTs, channel, user, question) {
  const body = [
    `@claude ${question}`,
    '',
    '---',
    `<!-- slack-channel:${channel} slack-thread:${threadTs} slack-user:${user} -->`,
  ].join('\n');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({
      title: `[Slack:${threadTs}] ${question.slice(0, 60)}`,
      body,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('createIssue failed', res.status, data);
    throw new Error(`createIssue ${res.status}: ${JSON.stringify(data)}`);
  }
  console.log('createIssue ok', data.number);
  return data.number;
}

async function addComment(issueNumber, question) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ body: `@claude ${question}` }),
  });
  if (!res.ok) {
    const data = await res.json();
    console.error('addComment failed', res.status, data);
    throw new Error(`addComment ${res.status}: ${JSON.stringify(data)}`);
  }
  console.log('addComment ok', issueNumber);
}

function shouldHandleThreadReply(event) {
  // Only thread replies (must have thread_ts and not equal to ts = top-level message)
  if (!event.thread_ts || event.thread_ts === event.ts) return false;
  // Skip bot's own messages and other bots
  if (event.bot_id || event.subtype === 'bot_message') return false;
  // Skip message edits/deletes
  if (event.subtype) return false;
  // Skip if message contains mention (app_mention will handle it)
  if (/<@[A-Z0-9]+>/.test(event.text || '')) return false;
  return true;
}

async function handleMention(event) {
  const { text, channel, ts, thread_ts, user } = event;
  const question = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) return;
  const slackThread = thread_ts || ts;

  await postSlackThinking(channel, slackThread);

  const existing = await findIssueByThread(slackThread);
  if (existing) {
    await addComment(existing, question);
  } else if (event.type === 'app_mention') {
    // Only create a new issue from explicit mention, not from arbitrary thread replies
    await createIssue(slackThread, channel, user, question);
  } else {
    console.log('thread reply ignored (no existing issue)', slackThread);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  const ok = verifySlackSignature(
    rawBody,
    req.headers['x-slack-request-timestamp'],
    req.headers['x-slack-signature']
  );
  if (!ok) return res.status(401).end('Invalid signature');

  const body = JSON.parse(rawBody);

  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Ignore Slack retries to prevent duplicate processing
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).end();
  }

  if (body.type === 'event_callback') {
    const event = body.event;
    try {
      if (event?.type === 'app_mention') {
        await handleMention(event);
      } else if (event?.type === 'message' && shouldHandleThreadReply(event)) {
        await handleMention(event);
      }
    } catch (err) {
      console.error('event handling error', err);
    }
  }

  res.status(200).end();
}
