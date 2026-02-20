require('dotenv').config();
const { App } = require('@slack/bolt');
const cron = require('node-cron');

// ─── Initialize Slack App ───────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3000,
});

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

// ─── Rating Scale Config ────────────────────────────────────────────
function getCategory(rating) {
  if (rating >= 9) return 'promoter';
  if (rating >= 7) return 'passive';
  return 'detractor';
}

function getCategoryLabel(category) {
  return { promoter: 'Promoter', passive: 'Neutral', detractor: 'Detractor' }[category];
}

function getCategoryEmoji(category) {
  return { promoter: ':large_green_circle:', passive: ':large_yellow_circle:', detractor: ':red_circle:' }[category];
}

function getFollowUpQuestion(category) {
  return {
    promoter: "That's great to hear. What's working well, and what would make us even better?",
    passive: "Thanks for being real. What's the one thing that would move us from good to great for you?",
    detractor: "We appreciate your honesty. What's the biggest thing we should change right now?",
  }[category];
}

// ─── Build the survey message blocks ────────────────────────────────
function buildSurveyMessage() {
  const ratingButtons = [];

  // Row 1: 1-5
  const row1 = [];
  for (let i = 1; i <= 5; i++) {
    row1.push({
      type: 'button',
      text: { type: 'plain_text', text: String(i), emoji: true },
      action_id: `ebls_rating_${i}`,
      value: String(i),
    });
  }

  // Row 2: 6-10
  const row2 = [];
  for (let i = 6; i <= 10; i++) {
    row2.push({
      type: 'button',
      text: { type: 'plain_text', text: String(i), emoji: true },
      action_id: `ebls_rating_${i}`,
      value: String(i),
      ...(i >= 9 ? { style: 'primary' } : {}),
    });
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':bar_chart: *Monthly Pulse Check*\n\nHey! Quick one — takes 30 seconds.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How likely are you to recommend Pickyourtrail as a great place to work?*\n\nPick a number. Be honest — that\'s the whole point.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '`1` — Not likely at all · · · `10` — Absolutely',
      },
    },
    {
      type: 'actions',
      block_id: 'rating_row_1',
      elements: row1,
    },
    {
      type: 'actions',
      block_id: 'rating_row_2',
      elements: row2,
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

// ─── Handle rating button clicks ────────────────────────────────────
// Register handlers for all 10 ratings
for (let i = 1; i <= 10; i++) {
  app.action(`ebls_rating_${i}`, async ({ ack, body, client, action }) => {
    await ack();

    const rating = parseInt(action.value);
    const category = getCategory(rating);
    const categoryLabel = getCategoryLabel(category);
    const emoji = getCategoryEmoji(category);
    const question = getFollowUpQuestion(category);

    // Look up the user's email
    let userEmail = '';
    try {
      const userInfo = await client.users.info({ user: body.user.id });
      userEmail = userInfo.user.profile.email || body.user.id;
    } catch (e) {
      userEmail = body.user.id;
    }

    // Open a modal for the follow-up question
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'ebls_followup_modal',
          private_metadata: JSON.stringify({
            rating,
            category,
            email: userEmail,
            channelId: body.channel?.id || body.container?.channel_id,
            messageTs: body.message?.ts || body.container?.message_ts,
          }),
          title: { type: 'plain_text', text: 'One more thing' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Skip' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${emoji} You rated *${rating}/10* — ${categoryLabel}`,
              },
            },
            { type: 'divider' },
            {
              type: 'input',
              block_id: 'feedback_block',
              optional: true,
              label: { type: 'plain_text', text: question },
              element: {
                type: 'plain_text_input',
                action_id: 'feedback_input',
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text: 'One word or a paragraph — whatever feels right.',
                },
              },
            },
          ],
        },
      });
    } catch (err) {
      console.error('Error opening modal:', err);
    }
  });
}

// ─── Handle modal submission ────────────────────────────────────────
app.view('ebls_followup_modal', async ({ ack, view, client }) => {
  await ack();

  const meta = JSON.parse(view.private_metadata);
  const feedback =
    view.state.values?.feedback_block?.feedback_input?.value || '';

  // Save to Google Sheets
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        email: meta.email,
        rating: meta.rating,
        category: meta.category,
        feedback: feedback,
        source: 'slack',
        month: new Date().toLocaleString('en-US', {
          month: 'long',
          year: 'numeric',
        }),
      }),
    });

    const result = await response.json();
    console.log('Saved to sheet:', result);

    if (result.status === 'duplicate') {
      // DM the user that they already submitted
      try {
        await client.chat.postMessage({
          channel: meta.email, // Slack will resolve email to DM
          text: ":wave: Looks like you've already submitted for this month. We got your response — thanks!",
        });
      } catch (e) {
        // Fallback: post in the original channel
      }
      return;
    }
  } catch (err) {
    console.error('Error saving to Google Sheets:', err);
  }

  // Update the original message to show completion
  if (meta.channelId && meta.messageTs) {
    try {
      await client.chat.update({
        channel: meta.channelId,
        ts: meta.messageTs,
        text: 'Monthly pulse check — completed!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Done — you rated ${meta.rating}/10*\n\nThanks for taking 30 seconds. We compile results on the 5th and share what we're acting on by the 10th.`,
            },
          },
        ],
      });
    } catch (e) {
      console.error('Error updating message:', e);
    }
  }
});

// ─── Handle modal close/skip (view_closed) ──────────────────────────
app.view({ callback_id: 'ebls_followup_modal', type: 'view_closed' }, async ({ ack, view }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);

  // Still save the rating even if they skipped the text feedback
  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        email: meta.email,
        rating: meta.rating,
        category: meta.category,
        feedback: '',
        source: 'slack',
        month: new Date().toLocaleString('en-US', {
          month: 'long',
          year: 'numeric',
        }),
      }),
    });
  } catch (err) {
    console.error('Error saving skipped response:', err);
  }
});

// ─── Send survey to all workspace members ───────────────────────────
async function sendMonthlySurvey() {
  console.log(`[EBLS] Sending monthly survey — ${new Date().toISOString()}`);

  try {
    const blocks = buildSurveyMessage();
    let cursor;
    let totalSent = 0;
    let errors = 0;

    do {
      const result = await app.client.users.list({
        cursor,
        limit: 200,
      });

      const members = result.members.filter(
        (m) => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT' && !m.is_restricted
      );

      for (const member of members) {
        try {
          await app.client.chat.postMessage({
            channel: member.id,
            text: 'Monthly pulse check — how are we doing?',
            blocks: blocks,
          });
          totalSent++;

          // Rate limiting: ~1 message per second to stay safe
          await new Promise((r) => setTimeout(r, 1200));
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

// ─── Manual trigger via slash command ───────────────────────────────
app.command('/ebls-send', async ({ ack, command, client, respond }) => {
  await ack();

  // Only allow workspace admins to trigger manually
  try {
    const userInfo = await client.users.info({ user: command.user_id });
    if (!userInfo.user.is_admin) {
      await respond({
        text: "Only workspace admins can trigger the survey manually.",
        response_type: 'ephemeral',
      });
      return;
    }
  } catch (e) {
    // If we can't check, proceed anyway
  }

  await respond({
    text: ':rocket: Sending the monthly E-BLS survey to all members now...',
    response_type: 'ephemeral',
  });

  await sendMonthlySurvey();
});

// ─── Test: Send survey to a single user ─────────────────────────────
app.command('/ebls-test', async ({ ack, command, client, respond }) => {
  await ack();

  await respond({
    text: ':test_tube: Sending a test survey to you...',
    response_type: 'ephemeral',
  });

  try {
    const blocks = buildSurveyMessage();
    await client.chat.postMessage({
      channel: command.user_id,
      text: 'Monthly pulse check — how are we doing? (TEST)',
      blocks: blocks,
    });
  } catch (err) {
    console.error('Error sending test:', err);
    await respond({
      text: `:x: Failed to send test: ${err.message}`,
      response_type: 'ephemeral',
    });
  }
});

// ─── Cron: Auto-send on the 1st of every month ─────────────────────
const cronSchedule = process.env.SURVEY_CRON || '0 9 1 * *';
cron.schedule(cronSchedule, () => {
  console.log('[EBLS] Cron triggered — sending monthly survey');
  sendMonthlySurvey();
});

// ─── Start ──────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log(`⚡ E-BLS Slack bot is running`);
  console.log(`   Survey cron: ${cronSchedule}`);
  console.log(`   Sheets endpoint: ${GOOGLE_SCRIPT_URL ? 'configured' : 'NOT SET'}`);
})();
