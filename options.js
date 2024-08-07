function setTheme() {
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    document.body.classList.add("dark-mode");
  } else {
    document.body.classList.remove("dark-mode");
  }
}

// Call setTheme initially
setTheme();

// Listen for changes in color scheme
window.matchMedia("(prefers-color-scheme: dark)").addListener(setTheme);

function maskApiKey(apiKey) {
  if (apiKey.length <= 4) {
    return apiKey;
  }
  return "*".repeat(apiKey.length - 4) + apiKey.slice(-4);
}

function displayMaskedApiKey(apiKey) {
  var maskedKeyElement = document.getElementById("maskedApiKey");
  if (apiKey) {
    maskedKeyElement.textContent = "Saved API Key: " + maskApiKey(apiKey);
  } else {
    maskedKeyElement.textContent = "";
  }
}

function saveOptions() {
  var apiKey = document.getElementById("apiKey").value.trim();
  var status = document.getElementById("status");

  if (apiKey === "") {
    status.textContent = "Error: API key cannot be empty.";
    status.className = "error";
    return;
  }

  if (apiKey.includes('"') || apiKey.includes("'")) {
    status.textContent = "Error: API key should not contain quotation marks.";
    status.className = "error";
    return;
  }

  chrome.storage.sync.set(
    {
      youtubelabelsapikey: apiKey,
    },
    function () {
      status.textContent = "API key saved successfully.";
      status.className = "success";
      displayMaskedApiKey(apiKey);
      document.getElementById("apiKey").value = ""; // Clear the input field
      setTimeout(function () {
        status.textContent = "";
        status.className = "";
      }, 3000);
    }
  );
}

function restoreOptions() {
  chrome.storage.sync.get(
    {
      youtubelabelsapikey: "",
    },
    function (items) {
      displayMaskedApiKey(items.youtubelabelsapikey);
    }
  );
}

document.addEventListener("DOMContentLoaded", function () {
  restoreOptions();
  setTheme();
});
document.getElementById("save").addEventListener("click", saveOptions);
