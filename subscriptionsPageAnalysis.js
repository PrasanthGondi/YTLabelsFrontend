(function () {
  if (window.hasRunSubscriptionAnalysis) return;
  window.hasRunSubscriptionAnalysis = true;

  console.log("Subscription page analysis script loaded");

  let processedVideos = new Set();

  let lastAlertTime = 0;
  const alertCooldown = 60000; // 1 minute in milliseconds

  // Add this function to manage alerts
  function showAlert(message) {
    const currentTime = Date.now();
    if (currentTime - lastAlertTime > alertCooldown) {
      window.alert(message);
      lastAlertTime = currentTime;
    }
  }

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  function isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    const windowHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const windowWidth =
      window.innerWidth || document.documentElement.clientWidth;

    // Consider an element visible if any part of it is in the viewport
    return (
      rect.top < windowHeight &&
      rect.bottom > 0 &&
      rect.left < windowWidth &&
      rect.right > 0
    );
  }

  function throttle(func, limit) {
    let inThrottle;
    return function () {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  async function analyzeVisibleVideos() {
    console.log("Analyzing visible subscription videos...");
    const videoRenderers = findVideoElements();
    console.log(`Found ${videoRenderers.length} video elements`);

    const visibleVideos =
      Array.from(videoRenderers).filter(isElementInViewport);

    console.log(`${visibleVideos.length} videos are currently visible`);

    for (const renderer of visibleVideos) {
      const videoId = getVideoId(renderer);
      if (videoId && !processedVideos.has(videoId)) {
        processedVideos.add(videoId);
        await processVideo(renderer, videoId);
      }
    }
  }

  function findVideoElements() {
    const selectors = [
      "ytd-grid-video-renderer",
      "ytd-rich-item-renderer",
      "#contents ytd-rich-item-renderer",
      "#contents > ytd-rich-item-renderer",
      "ytd-rich-grid-row",
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        console.log(`Found video elements using selector: ${selector}`);
        return elements;
      }
    }

    console.log("Could not find video elements with known selectors");
    return [];
  }

  function getVideoId(renderer) {
    const linkSelectors = [
      "a#video-title",
      "a#video-title-link",
      "a[href^='/watch?v=']",
    ];

    for (const selector of linkSelectors) {
      const linkElement = renderer.querySelector(selector);
      if (linkElement) {
        const href = linkElement.getAttribute("href");
        if (href) {
          const match = href.match(/[?&]v=([^&]+)/);
          if (match) return match[1];
        }
      }
    }

    return null;
  }
  function removeLoader(thumbnailContainer, videoId) {
    const loader = document.getElementById(`loader-${videoId}`);
    if (loader && loader.parentNode === thumbnailContainer) {
      thumbnailContainer.removeChild(loader);
    }
  }

  async function processVideo(renderer, videoId) {
    console.log(`Processing video: ${videoId}`);
    const thumbnailContainer = renderer.querySelector("#thumbnail");
    // The upcoming or premiers labels will be on the thumbnail container. Look for upcoming videos and skip them.
    const upcomingLabel = thumbnailContainer.querySelector(
      ".badge-shape-wiz__text"
    );
    console.log("Upcoming label", upcomingLabel);
    if (upcomingLabel && upcomingLabel.textContent === "UPCOMING") {
      applyErrorResults(renderer, "Upcoming video");
      return;
    }
    const loader = document.createElement("div");
    loader.classList.add("thumbnail-bounce-loader");
    loader.id = `loader-${videoId}`;
    loader.innerHTML = `
      <div class="bounce11"></div>
      <div class="bounce12"></div>
      <div class="bounce13"></div>
    `;
    thumbnailContainer.appendChild(loader);
    try {
      const cachedData = await getCachedData(videoId);
      if (cachedData) {
        if (cachedData.noTranscript) {
          applyErrorResults(renderer, "No transcript available");
          return;
        }
        if (cachedData.notSafe) {
          removeLoader(thumbnailContainer, videoId);
          applyErrorResults(renderer, "Not safe");
          return;
        }
        if (cachedData.tooLarge) {
          removeLoader(thumbnailContainer, videoId);
          applyErrorResults(renderer, "Transcript too large");
          return;
        }
        applyAnalysisResults(renderer, cachedData);
      } else {
        const mongoData = await fetchFromMongoDB(videoId);
        if (mongoData) {
          if (mongoData.noTranscript) {
            cacheData(videoId, mongoData);
            applyErrorResults(renderer, "No transcript available");
            return;
          }
          if (mongoData.notSafe) {
            cacheData(videoId, mongoData);
            removeLoader(thumbnailContainer, videoId);
            applyErrorResults(renderer, "Not safe");
            return;
          }
          if (mongoData.tooLarge) {
            cacheData(videoId, mongoData);
            removeLoader(thumbnailContainer, videoId);
            applyErrorResults(renderer, "Too large");
            return;
          }
          cacheData(videoId, mongoData);
          applyAnalysisResults(renderer, mongoData);
        } else {
          await analyzeVideo(renderer, videoId);
        }
      }
    } catch (error) {
      console.error(`Error processing video ${videoId}:`, error);
    } finally {
      removeLoader(thumbnailContainer, videoId);
    }
  }

  async function getCachedData(videoId) {
    return new Promise((resolve) => {
      chrome.storage.local.get([videoId], (result) => {
        resolve(result[videoId] ? result[videoId].analysis : null);
      });
    });
  }

  async function fetchFromMongoDB(videoId) {
    try {
      const response = await fetch(
        "https://youtubelabelsbackend.uc.r.appspot.com/database-check",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        return data.analysis || null;
      }
    } catch (error) {
      console.error("Error fetching analysis from MongoDB:", error);
      return null;
    }
    return null;
  }

  function cacheData(videoId, data) {
    const cachedData = {
      analysis: data,
      timestamp: Date.now(),
    };
    chrome.storage.local.set({ [videoId]: cachedData });
  }

  async function getApiKey() {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get(["youtubelabelsapikey"], function (result) {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          const apiKey = result.youtubelabelsapikey;
          console.log("API key retrieved");
          resolve(apiKey);
        }
      });
    });
  }

  async function analyzeVideo(renderer, videoId) {
    const thumbnailUrl = await getThumbnailUrl(videoId);
    const title = renderer.querySelector("#video-title").textContent.trim();
    const thumbnailContainer = renderer.querySelector("#thumbnail");
    const geminiApiKey = await getApiKey();
    if (!geminiApiKey) {
      alert("API key not found. Please set it up in the extension options.");
      chrome.runtime.sendMessage({ action: "openOptionsPage" });
      return;
    }
    try {
      const response = await fetch(
        "https://youtubelabelsbackend.uc.r.appspot.com/analyse-text-subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title,
            transcript: "No transcript available",
            thumbnailUrl: thumbnailUrl,
            videoId: videoId,
            geminiApiKey: geminiApiKey,
          }),
        }
      );

      let data;
      let errorMessage;

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        try {
          data = await response.json();
        } catch (jsonError) {
          console.error("Error parsing JSON:", jsonError);
          errorMessage = "Error parsing response";
        }
      } else {
        errorMessage = await response.text();
      }

      if (response.ok && data) {
        if (data.noTranscript || data.notSafe || data.tooLarge) {
          cacheData(videoId, data);
          removeLoader(thumbnailContainer, videoId);
          let statusMessage = data.noTranscript
            ? "No transcript available"
            : data.notSafe
            ? "Not safe for analysis"
            : "Transcript too large";
          applyErrorResults(renderer, statusMessage);
          return;
        }
        cacheData(videoId, data);
        applyAnalysisResults(renderer, data);
      } else {
        console.error(
          "Error response:",
          errorMessage || (data && data.error) || "Unknown error"
        );
        handleErrorResponse(
          errorMessage || (data && data.error) || "Unknown error",
          renderer,
          thumbnailContainer,
          videoId
        );
      }
    } catch (error) {
      console.error("Error analyzing video:", error);
      handleErrorResponse(
        error.message || "An unexpected error occurred",
        renderer,
        thumbnailContainer,
        videoId
      );
    }
  }

  function handleErrorResponse(
    errorMessage,
    renderer,
    thumbnailContainer,
    videoId
  ) {
    removeLoader(thumbnailContainer, videoId);

    if (typeof errorMessage === "object" && errorMessage !== null) {
      errorMessage = errorMessage.message || JSON.stringify(errorMessage);
    }

    console.error("Handling error:", errorMessage);

    // Handle specific errors with labels
    if (
      errorMessage.includes("No transcript found") ||
      errorMessage.includes("Transcript is too large") ||
      errorMessage.includes("not safe for analysis")
    ) {
      applyErrorResults(renderer, errorMessage);
    }
    // Handle general errors with window.alert and a generic label
    else if (
      errorMessage.includes("API key not valid") ||
      errorMessage.includes("Limit reached")
    ) {
      // window.alert(`Error: ${errorMessage}`);
      showAlert(`Error: ${errorMessage}`);
      applyErrorResults(renderer, "Analysis failed");
    }
    // Handle unexpected errors
    else {
      // window.alert(`An unexpected error occurred: ${errorMessage}`);
      showAlert(`An unexpected error occurred: ${errorMessage}`);
      applyErrorResults(renderer, "Analysis failed");
    }
  }

  async function getThumbnailUrl(videoId) {
    const qualities = [
      "maxresdefault",
      "sddefault",
      "hqdefault",
      "mqdefault",
      "default",
    ];
    for (const quality of qualities) {
      const url = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
      try {
        const response = await fetch(url, { method: "HEAD" });
        if (response.ok) {
          return url;
        }
      } catch (error) {
        console.error(`Error checking ${quality} thumbnail:`, error);
      }
    }
    return null;
  }

  function applyAnalysisResults(renderer, data) {
    const thumbnailContainer = renderer.querySelector("#thumbnail");
    if (thumbnailContainer) {
      // Create the overlay
      const overlay = document.createElement("div");
      overlay.classList.add("subscriptions-overlay");
      removeLoader(thumbnailContainer, data.videoId);
      let videoTime = "";

      // Position the overlay absolutely within the thumbnail container
      overlay.style.position = "absolute";
      overlay.style.zIndex = "1";

      // Set position based on data
      overlay.style.top = data.thumbnailAnalysis.labelPosition.includes("top")
        ? "5px"
        : "auto";
      overlay.style.bottom = data.thumbnailAnalysis.labelPosition.includes(
        "bottom"
      )
        ? "5px"
        : "auto";
      overlay.style.left = data.thumbnailAnalysis.labelPosition.includes("left")
        ? "5px"
        : "auto";
      overlay.style.right = data.thumbnailAnalysis.labelPosition.includes(
        "right"
      )
        ? "5px"
        : "auto";

      // Set colors
      overlay.style.backgroundColor = data.thumbnailAnalysis.labelBGColor;
      overlay.style.color = data.thumbnailAnalysis.labelTextColor;

      // Prepare labels
      let labels = [];
      if (data.label) labels.push(data.label);
      if (data.thumbnailAnalysis && data.thumbnailAnalysis.clickbait)
        labels.push("Clickbait");
      if (
        data.thumbnailAnalysis &&
        data.thumbnailAnalysis.imageAuthenticity !== "Authentic"
      ) {
        labels.push(data.thumbnailAnalysis.imageAuthenticity);
      }
      if (data.thumbnailAnalysis.labelPosition === "bottom-right") {
        videoTime = renderer.querySelector(
          ".badge-shape-wiz__text"
        ).textContent;
        if (videoTime) {
          labels.push(videoTime);
        }
      }

      overlay.textContent = labels.join(" | ");

      // Ensure the thumbnail container is positioned relatively
      if (getComputedStyle(thumbnailContainer).position === "static") {
        thumbnailContainer.style.position = "relative";
      }

      // Add the overlay to the thumbnail container
      thumbnailContainer.appendChild(overlay);
    }

    // Handle accurate title
    if (data.accurateTitle) {
      const titleElement = renderer.querySelector("#video-title");
      if (titleElement) {
        const titleLength = data.accurateTitle.length;

        if (titleLength < 60) {
          titleElement.textContent = `${data.accurateTitle} 💯`;
        } else {
          titleElement.textContent = `💯 ${data.accurateTitle}`;
        }

        if (titleLength <= 50) {
          titleElement.style.fontSize = "16px"; // Larger font for short titles
        } else if (titleLength <= 75) {
          titleElement.style.fontSize = "15px"; // Medium font for medium titles
        } else if (titleLength <= 100) {
          titleElement.style.fontSize = "14px"; // Medium font for medium titles
        } else if (titleLength <= 150) {
          titleElement.style.fontSize = "13px"; // Smaller font for long titles
        } else {
          titleElement.style.fontSize = "12px"; // Smallest font for very long titles
        }
      }
    }
  }

  function applyErrorResults(renderer, errorMessage) {
    const thumbnailContainer = renderer.querySelector("#thumbnail");
    if (thumbnailContainer) {
      const overlay = document.createElement("div");
      overlay.classList.add("clickbait-overlay");

      overlay.textContent = errorMessage;
      overlay.style.backgroundColor = "#e50914";
      overlay.style.color = "white";
      thumbnailContainer.appendChild(overlay);
    }
  }

  function observePageChanges() {
    const observer = new MutationObserver(
      debounce(() => {
        if (location.pathname === "/feed/subscriptions") {
          analyzeVisibleVideos();
        }
      }, 1000)
    );

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    let ticking = false;
    const throttledAnalyzeVisibleVideos = throttle(analyzeVisibleVideos, 300);

    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          window.requestAnimationFrame(() => {
            if (location.pathname === "/feed/subscriptions") {
              throttledAnalyzeVisibleVideos();
            }
            ticking = false;
          });
          ticking = true;
        }
      },
      { passive: true }
    );

    return observer;
  }

  function retryAnalysis(maxAttempts = 10, delay = 1000) {
    let attempts = 0;

    function attempt() {
      console.log(`Attempt ${attempts + 1} to find video elements`);
      const videoRenderers = findVideoElements();

      if (videoRenderers.length > 0) {
        console.log(`Found ${videoRenderers.length} video elements`);
        analyzeVisibleVideos();
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(attempt, delay);
      } else {
        console.log("Max attempts reached. Could not find video elements.");
      }
    }

    attempt();
  }

  function addHistoryChangeListener(callback) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      originalPushState.apply(this, arguments);
      callback();
    };

    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      callback();
    };

    window.addEventListener("popstate", callback);
  }

  function startPeriodicCheck() {
    setInterval(() => {
      if (location.pathname === "/feed/subscriptions") {
        analyzeVisibleVideos();
      }
    }, 5000); // Check every 5 seconds
  }

  function initializeAnalysis() {
    console.log("Initializing analysis...");
    let observer;

    function handleUrlChange() {
      if (location.pathname === "/feed/subscriptions") {
        // analyzeVisibleVideos(); // Analyze immediately when navigating to subscriptions
        retryAnalysis();
        if (!observer) {
          observer = observePageChanges();
        }
      } else {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      }
    }

    // Initial check
    handleUrlChange();

    // Listen for URL changes
    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("pushstate", handleUrlChange);
    window.addEventListener("replacestate", handleUrlChange);

    // Start periodic check
    startPeriodicCheck();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initializeAnalysis();
      addHistoryChangeListener(initializeAnalysis);
    });
  } else {
    initializeAnalysis();
    addHistoryChangeListener(initializeAnalysis);
  }

  console.log("Subscription page analysis script setup complete");
})();
