/* DOM elements */
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");
const chatWindow = document.getElementById("chatWindow");
// Replace with your Cloudflare Worker URL that forwards requests to OpenAI Chat Completions API.
// Do NOT put your OpenAI API key in this client-side code.
const WORKER_URL = "https://lorealbot.carleigh-skye.workers.dev/"; // <-- set this

// Strict system prompt: only answer L'Oréal / beauty-related queries; refuse others.
const SYSTEM_PROMPT = `You are a knowledgeable assistant that ONLY answers questions about L'Oréal products, routines, and beauty-related recommendations. Provide concise, accurate, and brand-appropriate information about L'Oréal product lines, ingredients, recommended usage, and routine suggestions.

If a user's question is outside the scope of L'Oréal products, beauty routines, or related topics, politely refuse using this exact reply:
"I'm sorry — I can only help with questions about L'Oréal products, routines, and beauty recommendations. For other topics, please consult the appropriate specialist or visit L'Oréal's official website or customer support."

Do NOT provide information, instructions, or recommendations on topics unrelated to L'Oréal or beauty (for example: legal, medical, political, non-beauty product recommendations). If the user insists, repeat the same polite refusal and offer the suggestion above.`;

// Conversation stored in-memory for this session. The worker will forward it to OpenAI.
const messages = [{ role: "system", content: SYSTEM_PROMPT }];

// Simple in-memory user profile to capture small bits of user-specific context
// (kept in memory only; not persisted). We'll include this as a system message
// when sending to the worker so the assistant can reference name/preferences.
const userProfile = {
  name: null,
  // you can extend this later with skinType, hairType, preferences, etc.
};

// Try to detect a user-provided name from common phrasings and store it.
function detectAndStoreName(text) {
  // common patterns: "my name is Anna", "I'm Anna", "I am Anna", "call me Anna"
  const patterns = [
    /my name is ([A-Za-z\-']{2,30})/i,
    /i\'?m ([A-Za-z\-']{2,30})/i,
    /i am ([A-Za-z\-']{2,30})/i,
    /call me ([A-Za-z\-']{2,30})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const name = m[1].trim();
      // If we already have a name, don't overwrite unless different
      if (
        !userProfile.name ||
        userProfile.name.toLowerCase() !== name.toLowerCase()
      ) {
        userProfile.name = name;
        appendMessage(
          "assistant",
          `Nice to meet you, ${escapeHtml(
            name
          )}! I'll remember your name for this session.`
        );
      }
      return true;
    }
  }
  return false;
}

// Start with an empty chat window; we'll append the initial assistant message after
// the appendMessage helper is defined so it uses the same bubble layout.
chatWindow.innerHTML = "";

// Verify the Cloudflare Worker is reachable. This runs silently for developers
// (no UI changes) and logs the result to the console so you can confirm the
// client communicates with the worker rather than directly to OpenAI.
async function verifyWorker() {
  try {
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: "health-check" }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("Worker health-check failed:", resp.status, text);
      return;
    }

    const json = await resp.json().catch(() => null);
    console.info("Worker reachable — health-check response:", json);
  } catch (err) {
    console.error("Worker health-check error:", err);
  }
}

// Run verification on load (does not affect conversation state)
verifyWorker();

// Simple helper to escape text before inserting into innerHTML
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function appendMessage(role, text) {
  const safe = escapeHtml(text);
  const msgEl = document.createElement("div");
  msgEl.className = `msg ${role === "user" ? "user" : "assistant"}`;

  // bubble container
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<div class="text">${safe}</div>`;

  msgEl.appendChild(bubble);
  chatWindow.appendChild(msgEl);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// Initial assistant greeting using the bubble UI
appendMessage(
  "assistant",
  "👋 Hello! Ask me about L'Oréal products, routines, or recommendations."
);

// Disable/enable form while waiting for response
function setLoading(isLoading) {
  userInput.disabled = isLoading;
  const submit = chatForm.querySelector('button[type="submit"]');
  if (submit) submit.disabled = isLoading;
}

/* Handle form submit */
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const userText = userInput.value.trim();
  if (!userText) return;

  // Update the latest question preview (resets/overwrites with each new question)
  const latestEl = document.getElementById("latestQuestion");
  if (latestEl) {
    latestEl.innerHTML = `<strong>Your question:</strong> ${escapeHtml(
      userText
    )}`;
  }

  // Add user message locally and to messages array
  appendMessage("user", userText);
  messages.push({ role: "user", content: userText });
  userInput.value = "";

  // Show a temporary loader
  const thinkingId = `thinking-${Date.now()}`;
  chatWindow.innerHTML += `<p id="${thinkingId}"><em>Thinking…</em></p>`;
  chatWindow.scrollTop = chatWindow.scrollHeight;
  setLoading(true);

  try {
    // Before sending, detect a name in the latest userText and store it if present
    detectAndStoreName(userText);

    // Build the outgoing messages array. We include the original system prompt
    // (messages[0]) and an extra system message containing a small user profile
    // so the model can reference the user's name and other details.
    const outgoing = [
      messages[0],
      {
        role: "system",
        content: `User profile: ${JSON.stringify(userProfile)}`,
      },
      ...messages.slice(1),
    ];

    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // POST the outgoing messages array. The worker should forward this to OpenAI Chat Completions.
      body: JSON.stringify({ messages: outgoing }),
    });

    // remove loader
    const thinkingEl = document.getElementById(thinkingId);
    if (thinkingEl) thinkingEl.remove();

    if (!resp.ok) {
      const text = await resp.text();
      appendMessage(
        "assistant",
        `Error from worker: ${resp.status} ${escapeHtml(text)}`
      );
      setLoading(false);
      return;
    }

    const data = await resp.json();

    // Expecting OpenAI-style response: data.choices[0].message.content
    const assistantText =
      data?.choices?.[0]?.message?.content ||
      data?.error ||
      JSON.stringify(data);

    // Save assistant response to messages for context in future requests
    messages.push({ role: "assistant", content: String(assistantText) });

    appendMessage("assistant", String(assistantText));
  } catch (err) {
    // remove loader
    const thinkingEl2 = document.getElementById(thinkingId);
    if (thinkingEl2) thinkingEl2.remove();
    appendMessage("assistant", `Network error: ${escapeHtml(err.message)}`);
  } finally {
    setLoading(false);
  }
});
