console.log("Content script loaded");

let finalResults = [];

async function getSearchResults() {
  console.log("Analyzing first 5 regular videos...");
  removeExistingOverlays();
  removeAccurateTitles();
  const videoRenderers = document.querySelectorAll("ytd-video-renderer");
  const results = [];
  let processedCount = 0;

  for (let i = 0; i < videoRenderers.length && processedCount < 5; i++) {
    const renderer = videoRenderers[i];
    const linkElement = renderer.querySelector("a#video-title");
    const videoId = linkElement
      ? extractVideoId(linkElement.getAttribute("href"))
      : null;

    if (!videoId || isShort(linkElement.getAttribute("href"))) {
      console.log(`Skipping item ${i + 1} (possibly a Short or invalid video)`);
      continue;
    }

    console.log("Video ID:", videoId);

    const cachedData = await getCachedData(videoId);
    if (cachedData) {
      console.log("Cached data found for videoId:", videoId);
      finalResults.push(cachedData);
      processedCount++;
      continue;
    }

    const mongoData = await fetchFromMongoDB(videoId);
    if (mongoData) {
      console.log("MongoDB data found for videoId:", videoId);
      cacheData(videoId, mongoData);
      finalResults.push(mongoData);
      processedCount++;
      continue;
    }

    const thumbnail = renderer.querySelector("#thumbnail img");
    const title = renderer.querySelector("#video-title");

    if (thumbnail && title) {
      const thumbnailUrl = await waitForThumbnailSrc(thumbnail);
      const videoTitle = title.textContent.trim();
      const alternateThumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

      if (thumbnailUrl || alternateThumbnailUrl) {
        results.push({
          videoId: videoId,
          title: videoTitle,
          thumbnailUrl: thumbnailUrl || alternateThumbnailUrl,
        });
        addLoadingOverlay(renderer);
        processedCount++;
      } else {
        console.log(`Skipping thumbnail ${processedCount + 1} due to timeout`);
      }
    }
  }

  console.log("Results:", results, "Final results:", finalResults);
  const uniqueResults = results.filter(
    (v, i, a) => a.findIndex((t) => t.videoId === v.videoId) === i
  );
  if (uniqueResults.length > 0) {
    addLoader();
    try {
      await sendDataToAPI(uniqueResults);
    } catch (error) {
      console.error("Error in API call:", error);
    } finally {
      removeLoader();
    }
  } else if (finalResults.length > 0) {
    await processApiResponse(finalResults);
  } else {
    console.log("No results found");
  }
}

function addLoader(width = "80%") {
  const firstVideoRenderer = document.querySelector("ytd-video-renderer");
  if (firstVideoRenderer) {
    const loader = document.createElement("div");
    loader.id = "analysis-loader";
    loader.style.cssText = `
      position: relative;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      width: ${width};
      height: 5px;
      margin-bottom: 10px;
      overflow: hidden;
    `;

    const loaderBar = document.createElement("div");
    loaderBar.style.cssText = `
      width: 100%;
      height: 100%;
      border-radius: 2px;
      background: linear-gradient(to right, #4285f4, #34a853, #fbbc05, #ea4335);
      background-size: 300% 100%;
      animation: gradientMove 2s ease infinite;
    `;

    loader.appendChild(loaderBar);

    const style = document.createElement("style");
    style.textContent = `
      @keyframes gradientMove {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
    `;

    document.head.appendChild(style);
    firstVideoRenderer.style.position = "relative";
    firstVideoRenderer.insertBefore(loader, firstVideoRenderer.firstChild);
  }
}

function clearSearchState() {
  finalResults = [];
  removeExistingOverlays();
  removeAccurateTitles();
  removeAllLoadingOverlays();
}

function removeLoader() {
  const loader = document.getElementById("analysis-loader");
  if (loader) {
    loader.remove();
  }
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

async function sendDataToAPI(results) {
  console.log(`Found ${results.length} results. Sending to API...`);
  const geminiApiKey = await getApiKey();
  if (!geminiApiKey) {
    alert("API key not found. Please set it up in the extension options.");
    chrome.runtime.sendMessage({ action: "openOptionsPage" });
    return;
  }
  try {
    const response = await fetch(
      "https://youtubelabelsbackendindia.el.r.appspot.com/analyse-text-batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: results, geminiApiKey: geminiApiKey }),
      }
    );

    const data = await response.json();

    if (response.ok) {
      console.log("API response from backend:", data);
      removeAllLoadingOverlays();
      data.results.forEach((result) => {
        cacheData(result.videoId, result);
        finalResults.push(result);
      });
      console.log("Final results after API call:", finalResults);
      removeLoader();
      processApiResponse(finalResults);
    } else {
      console.error("API response not OK:", response);
      throw new Error(data.error || "An unknown error occurred");
    }
  } catch (error) {
    console.error("Error sending data to API:", error);
    window.alert(`Error: ${error.message}`);
    removeLoader();
    removeAllLoadingOverlays();
    throw error; // Re-throw the error to be caught by the caller
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
      "https://youtubelabelsbackendindia.el.r.appspot.com/database-check",
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

function waitForThumbnailSrc(imgElement, timeout = 5000) {
  return new Promise((resolve) => {
    if (imgElement.src && !imgElement.src.includes("data:image")) {
      resolve(imgElement.src);
    } else {
      const observer = new MutationObserver(() => {
        if (imgElement.src && !imgElement.src.includes("data:image")) {
          observer.disconnect();
          resolve(imgElement.src);
        }
      });

      observer.observe(imgElement, {
        attributes: true,
        attributeFilter: ["src"],
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    }
  });
}

function addLoadingOverlay(renderer) {
  const thumbnailContainer = renderer.querySelector("#thumbnail");
  const loading = document.createElement("div");
  loading.innerHTML = `
    <div class="bounce11"></div>
    <div class="bounce12"></div>
    <div class="bounce13"></div>
  `;
  loading.classList.add("search-bounce-loader");
  thumbnailContainer.appendChild(loading);
}

function removeAllLoadingOverlays() {
  document
    .querySelectorAll(".search-bounce-loader")
    .forEach((overlay) => overlay.remove());
}

function extractVideoId(href) {
  if (!href) return null;
  const match = href.match(/[?&]v=([^&]+)/);
  return match ? match[1] : null;
}

function isShort(href) {
  return href.includes("/shorts/");
}

async function processApiResponse(results) {
  console.log("Processing API response...", results);

  for (const result of results) {
    if (!result.videoId) {
      console.warn("Result without videoId encountered, skipping.");
      continue;
    }

    let matchingRenderer = findVideoRenderer(result.videoId);

    if (!matchingRenderer) {
      console.log(
        `Video renderer not found for videoId: ${result.videoId}. Waiting for it to appear...`
      );
      matchingRenderer = await waitForVideoRenderer(result.videoId);
    }

    if (matchingRenderer) {
      console.log(`Processing renderer for videoId: ${result.videoId}`);
      await processRenderer(matchingRenderer, result);
    } else {
      console.warn(
        `Video renderer not found for videoId: ${result.videoId} after retries.`
      );
    }
  }
}

async function processRenderer(renderer, result) {
  const thumbnailContainer = renderer.querySelector("#thumbnail");
  if (thumbnailContainer) {
    const overlays = [];

    if (result.noTranscript) {
      overlays.push("No Transcript");
    } else if (result.notSafe) {
      overlays.push("Not Safe");
    } else if (result.tooLarge) {
      overlays.push("Too Large");
    } else {
      if (result.thumbnailAnalysis?.clickbait) {
        overlays.push("Clickbait Thumbnail");
      }
      if (result.thumbnailAnalysis?.imageAuthenticity !== "Authentic") {
        overlays.push(
          `${result.thumbnailAnalysis.imageAuthenticity} Thumbnail`
        );
      }
      if (result.label) {
        overlays.push(result.label);
      }
    }

    console.log("Overlays for videoId:", result.videoId, overlays);

    if (overlays.length > 0) {
      const overlay = document.createElement("div");
      overlay.textContent = overlays.join(" | ");
      overlay.classList.add(
        result.noTranscript || result.notSafe || result.tooLarge
          ? "clickbait-overlay"
          : "searchAnalysis-overlay"
      );
      if (!result.noTranscript || !result.notSafe || !result.tooLarge) {
        overlay.style.backgroundColor = result.thumbnailAnalysis.labelBGColor;
        overlay.style.color = result.thumbnailAnalysis.labelTextColor;
      }
      thumbnailContainer.appendChild(overlay);
    }
  } else {
    console.warn(
      `Thumbnail container not found for videoId: ${result.videoId}`
    );
  }

  if (!result.noTranscript || !result.notSafe || !result.tooLarge) {
    const titleElement = renderer.querySelector("#video-title");
    if (titleElement && result.accurateTitle) {
      const existingAccurateTitle = renderer.querySelector(".accurate-title");
      if (!existingAccurateTitle) {
        const accurateTitleElement = document.createElement("div");
        accurateTitleElement.textContent = `( ${result.accurateTitle} 💯 )`;
        accurateTitleElement.classList.add("accurate-title");
        accurateTitleElement.style.cssText =
          "font-size: 15px; color: #606060; margin-bottom: 2px;";
        titleElement.parentNode.insertBefore(
          accurateTitleElement,
          titleElement.nextSibling
        );
      }
    } else if (!titleElement) {
      console.warn(`Title element not found for videoId: ${result.videoId}`);
    }
  }
}

function findVideoRenderer(videoId) {
  return Array.from(document.querySelectorAll("ytd-video-renderer")).find(
    (renderer) => {
      const linkElement = renderer.querySelector("a#video-title");
      return (
        linkElement &&
        extractVideoId(linkElement.getAttribute("href")) === videoId
      );
    }
  );
}

function waitForVideoRenderer(videoId, maxAttempts = 5, interval = 1000) {
  return new Promise((resolve) => {
    let attempts = 0;
    const checkForRenderer = () => {
      const renderer = findVideoRenderer(videoId);
      if (renderer) {
        resolve(renderer);
      } else if (++attempts < maxAttempts) {
        setTimeout(checkForRenderer, interval);
      } else {
        console.warn(
          `Video renderer not found for videoId: ${videoId} after ${maxAttempts} attempts.`
        );
        resolve(null);
      }
    };
    checkForRenderer();
  });
}

function isSearchResultsPage() {
  return window.location.pathname === "/results";
}

function scrollForThumbnails() {
  return new Promise((resolve) => {
    const scrollDown = () => {
      window.scrollBy(0, window.innerHeight * 1.5);
      if (document.querySelectorAll("ytd-video-renderer").length >= 7) {
        setTimeout(scrollUp, 500);
      } else {
        setTimeout(scrollDown, 100);
      }
    };

    const scrollUp = () => {
      window.scrollTo(0, 0);
      setTimeout(resolve, 500);
    };

    scrollDown();
  });
}

function waitForSearchResults() {
  clearSearchState();
  const observer = new MutationObserver((mutations, obs) => {
    const searchResults = document.querySelectorAll("ytd-video-renderer");
    if (searchResults.length > 0) {
      console.log("Search results found");
      obs.disconnect();
      scrollForThumbnails().then(() => {
        setTimeout(getSearchResults, 1000);
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  setTimeout(() => {
    observer.disconnect();
    console.log("Stopped waiting for search results after 15 seconds");
  }, 15000);
}

function removeAccurateTitles() {
  document
    .querySelectorAll(".accurate-title")
    .forEach((element) => element.remove());
}

function removeExistingOverlays() {
  document
    .querySelectorAll(".clickbait-overlay, .searchAnalysis-overlay")
    .forEach((overlay) => overlay.remove());
}

if (isSearchResultsPage()) {
  console.log("On search results page, waiting for results to load");
  setTimeout(waitForSearchResults, 1000);
}

let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    console.log("URL changed:", url);
    if (isSearchResultsPage()) {
      console.log(
        "New search detected, clearing state and waiting for results to load"
      );
      clearSearchState();
      setTimeout(waitForSearchResults, 1000);
    }
  }
}).observe(document, { subtree: true, childList: true });
