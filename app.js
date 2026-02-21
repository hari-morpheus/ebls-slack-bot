require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

// ─── Express Receiver (serves both Slack events + web pages) ────────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const PORT = process.env.PORT || 3000;

// ─── Serve the survey webpage ───────────────────────────────────────

// Inject the Google Script URL into the HTML at serve time
receiver.router.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(
    "window.__EBLS_GOOGLE_SCRIPT_URL__ || ''",
    `'${GOOGLE_SCRIPT_URL}'`
  );
  res.type('html').send(html);
});

// API endpoint: Slack bot calls this when survey is completed via web
receiver.router.use(require('express').json());

receiver.router.post('/api/survey-complete', async (req, res) => {
  const { userId, rating } = req.body;
  if (!userId || !rating) return res.status(400).json({ error: 'Missing fields' });

  try {
    // Find the DM channel with this user and update the message
    const conversations = await app.client.conversations.list({
      types: 'im',
      limit: 200,
    });
    const dm = conversations.channels.find(c => c.user === userId);

    if (dm) {
      // Get the latest bot message in the DM
      const history = await app.client.conversations.history({
        channel: dm.id,
        limit: 5,
      });
      const botMessage = history.messages.find(m => m.bot_id && m.text?.includes('pulse'));

      if (botMessage) {
        await app.client.chat.update({
          channel: dm.id,
          ts: botMessage.ts,
          text: `Monthly pulse check — completed!`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:white_check_mark: *Done — you rated ${rating}/10*\n\nThanks for taking 30 seconds. We compile results on the 5th and share what we're acting on by the 10th.`,
              },
            },
          ],
        });
      }
    }
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error updating Slack message:', err.message);
    res.json({ status: 'ok' }); // Non-critical, don't fail
  }
});

// Health check
receiver.router.get('/health', (req, res) => {
  res.json({ status: 'running', uptime: process.uptime() });
});

// ─── Build the Slack DM (link to web survey) ────────────────────────

function getSurveyUrl(email) {
  // Railway gives us a public URL via RAILWAY_PUBLIC_DOMAIN
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  return `${baseUrl}?email=${encodeURIComponent(email)}`;
}

function buildSurveyMessage(email, userId) {
  const surveyUrl = getSurveyUrl(email) + `&uid=${userId}`;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':bar_chart: *Monthly Pulse Check*\n\nHey! It\'s that time — one question, thirty seconds, completely honest.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How likely are you to recommend Pickyourtrail as a great place to work?*\n\nClick below to share your take. We\'ll show you what we did with last month\'s feedback.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Take the 30-sec survey', emoji: true },
          url: surveyUrl,
          style: 'primary',
          action_id: 'open_survey',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':lock: Your name is attached, but only the People team sees individual responses.',
        },
      ],
    },
  ];
}

// Handle the button click acknowledgment (Slack requires this even for URL buttons)
app.action('open_survey', async ({ ack }) => {
  await ack();
});

// ─── Send survey to all workspace members ───────────────────────────

async function sendMonthlySurvey() {
  console.log(`[EBLS] Sending monthly survey — ${new Date().toISOString()}`);

  try {
    let cursor;
    let totalSent = 0;
    let errors = 0;

    do {
      const result = await app.client.users.list({ cursor, limit: 200 });

      const members = result.members.filter(
        (m) => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT' && !m.is_restricted
      );

      for (const member of members) {
        try {
          const email = member.profile?.email || '';
          const blocks = buildSurveyMessage(email, member.id);

          await app.client.chat.postMessage({
            channel: member.id,
            text: 'Monthly pulse check — how are we doing?',
            blocks: blocks,
          });
          totalSent++;
          await new Promise((r) => setTimeout(r, 1200)); // Rate limit
        } catch (err) {
          errors++;
          console.error(`Failed to DM ${member.name}:`, err.data?.error || err.message);
        }
      }

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    console.log(`[EBLS] Survey sent to ${totalSent} people (${errors} errors)`);
  } catch (err) {
    console.error('[EBLS] Fatal error sending survey:', err);
  }
}

// ─── Slash commands ─────────────────────────────────────────────────

app.command('/ebls-send', async ({ ack, command, client, respond }) => {
  await ack();
  try {
    const userInfo = await client.users.info({ user: command.user_id });
    if (!userInfo.user.is_admin) {
      await respond({ text: 'Only workspace admins can trigger the survey.', response_type: 'ephemeral' });
      return;
    }
  } catch (e) { /* proceed */ }

  await respond({ text: ':rocket: Sending the monthly E-BLS survey to all members now...', response_type: 'ephemeral' });
  await sendMonthlySurvey();
});

app.command('/ebls-test', async ({ ack, command, client, respond }) => {
  await ack();
  await respond({ text: ':test_tube: Sending a test survey to you...', response_type: 'ephemeral' });

  try {
    const userInfo = await client.users.info({ user: command.user_id });
    const email = userInfo.user.profile?.email || '';
    const blocks = buildSurveyMessage(email, command.user_id);

    await client.chat.postMessage({
      channel: command.user_id,
      text: 'Monthly pulse check — how are we doing? (TEST)',
      blocks: blocks,
    });
  } catch (err) {
    console.error('Error sending test:', err);
    await respond({ text: `:x: Failed: ${err.message}`, response_type: 'ephemeral' });
  }
});

// ─── Cron ───────────────────────────────────────────────────────────

const cronSchedule = process.env.SURVEY_CRON || '0 9 1 * *';
cron.schedule(cronSchedule, () => {
  console.log('[EBLS] Cron triggered — sending monthly survey');
  sendMonthlySurvey();
});

// ─── Start ──────────────────────────────────────────────────────────

(async () => {
  await app.start(PORT);
  console.log(`⚡ E-BLS Slack bot is running on port ${PORT}`);
  console.log(`   Survey page: http://localhost:${PORT}`);
  console.log(`   Survey cron: ${cronSchedule}`);
  console.log(`   Sheets endpoint: ${GOOGLE_SCRIPT_URL ? 'configured' : 'NOT SET'}`);
})();
