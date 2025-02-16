chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openAIForSummary") {
    const model = message.model || "gemini"; // Default to Gemini
    const transcript = message.transcript || "";

    if (!transcript.trim()) {
      console.error("❌ No transcript provided!");
      return;
    }

    let aiURL =
      model === "chatgpt"
        ? "https://chat.openai.com/"
        : "https://gemini.google.com/app";

    chrome.tabs.create({ url: aiURL }, (tab) => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.scripting.executeScript({
            target: { tabId },
            function: waitForAIInputAndSendMessage,
            args: [transcript, model],
          });
          chrome.tabs.onUpdated.removeListener(listener);
        }
      });
    });
  }
});

function waitForAIInputAndSendMessage(transcript, model) {
  console.log(`🔍 Waiting for ${model} input field...`);

  let attempts = 0;
  const maxAttempts = 20;

  const interval = setInterval(() => {
    let inputField, sendButton;

    if (model === "gemini") {
      inputField = document.querySelector(".ql-editor");
      sendButton = document.querySelector(".send-button");
    } else {
      inputField = document.querySelector(".ProseMirror");
      sendButton = document.querySelector("button[data-testid='send-button']");
    }

    if (inputField) {
      console.log(`✅ Input field found! Pasting transcript into ${model}...`);
      inputField.focus();

      if (model === "chatgpt") {
        // Insert text properly into ProseMirror
        const event = new InputEvent("input", { bubbles: true });
        inputField.textContent = transcript;
        inputField.dispatchEvent(event);
      } else {
        // Proper Gemini input handling
        inputField.innerHTML = `<p>${transcript.replace(/\n/g, "</p><p>")}</p>`;
        inputField.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Ensure send button is clicked after enabling
      setTimeout(() => {
        if (!sendButton || sendButton.hasAttribute("disabled")) {
          console.warn(
            `⏳ Waiting for ${model} send button to become active...`
          );
          sendButton = document.querySelector(
            model === "gemini"
              ? ".send-button"
              : "button[data-testid='send-button']"
          );
        }

        if (sendButton) {
          sendButton.removeAttribute("disabled");
          sendButton.click();
          console.log(`✅ Transcript sent successfully to ${model}!`);
        } else {
          console.error(`❌ Send button still not found for ${model}!`);
        }
      }, 1000);

      clearInterval(interval);
    }

    attempts++;
    if (attempts >= maxAttempts) {
      clearInterval(interval);
      console.error(
        `❌ Timeout: Input field not found for ${model} after ${maxAttempts} attempts!`
      );
    }
  }, 1000);
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") {
    chrome.runtime.openOptionsPage();
  }
});
