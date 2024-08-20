function extractAndDisplayInfo() {
  console.log("Running content script");

  let elements = {
    loaderContainer: null,
    alternativeTitleElement: null,
    descriptionDiv: null,
    sideTextDiv: null,
    factCheckDiv: null,
    errorContainer: null,
    clickbaitDiv: null,
    thumbnailAuthenticityDiv: null,
    sourceQueriesHeading: null,
    sourceQueriesContainer: null,
    reanalyseButton: null,
    rankedVideosContainer: null,
    requestReanalyseButton: null,
  };

  let processStarted = false;

  function getVideoId() {
    return new URLSearchParams(window.location.search).get("v");
  }

  function cleanupExpiredCache() {
    chrome.storage.local.get(null, (items) => {
      const now = Date.now();
      for (const [key, value] of Object.entries(items)) {
        if (
          key.startsWith("ranked_") &&
          value.expiryTime &&
          now > value.expiryTime
        ) {
          chrome.storage.local.remove(key);
        }
      }
    });
  }

  // function cleanupExpiredCache() {
  //   chrome.storage.local.get(null, (items) => {
  //     const now = Date.now();
  //     for (const [key, value] of Object.entries(items)) {
  //       if (key.startsWith("ranked_")) {
  //         chrome.storage.local.remove(key);
  //       }
  //     }
  //   });
  // }

  function getYouTubeThumbnails(videoId) {
    if (!videoId) {
      console.error("Could not find video ID in the URL");
      return null;
    }

    return {
      default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
      medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      standard: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
      maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };
  }

  function isNewYouTubeLayout() {
    // Check for the "fixed-columns-secondary" div, which contains the new right sidebar
    const fixedColumnsSecondary = document.getElementById(
      "fixed-columns-secondary"
    );

    // Check for the "below" div inside "primary-inner", which now contains suggestions
    const belowInPrimary = document.querySelector("#primary-inner #below");

    return fixedColumnsSecondary && belowInPrimary;
  }

  function isTheaterMode() {
    const sizeButton = document.querySelector(".ytp-size-button");
    if (sizeButton) {
      // Check if the title attribute contains "Theater mode"
      return !sizeButton.getAttribute("title").includes("Theater mode");
    }
    return false;
  }

  console.log("Theatre Mode:", isTheaterMode());

  async function getBestThumbnail(videoId) {
    const thumbnails = getYouTubeThumbnails(videoId);
    if (!thumbnails) return null;

    const qualities = ["maxres", "standard", "high", "medium", "default"];

    for (const quality of qualities) {
      const url = thumbnails[quality];
      try {
        const response = await fetch(url, { method: "HEAD" });
        if (response.ok) return url;
      } catch (error) {
        console.error(`Error checking ${quality} thumbnail:`, error);
      }
    }

    return null;
  }

  async function extractTranscript() {
    const showTranscriptButton = document.querySelector(
      "#button-container #primary-button button"
    );
    if (!showTranscriptButton) {
      throw new Error("🚫 Transcript not available for analysis");
    }

    // if (!showTranscriptButton) {
    //   console.log("Hello: Show transcript button not found");
    //   const button = document.getElementById("expand");
    //   if (button) {
    //     button.click();
    //     console.log("Button clicked successfully");
    //   } else {
    //     console.log("Button not found");
    //     throw new Error("🚫 Transcript not available for analysis");
    //   }
    // }

    const videoId = getVideoId();
    const cachedAnalysis = await getCachedAnalysis(videoId);
    cleanupExpiredCache();

    if (cacheAnalysis && cacheAnalysis.notSafe) {
      throw new Error("🚨 Transcript is not safe for analysis 🚨");
    }

    if (cachedAnalysis && cachedAnalysis.tooLarge) {
      throw new Error("🚫 Transcript is too large for analysis 🚫");
    }

    if (cachedAnalysis && !cachedAnalysis.noTranscript) {
      handleAPIResponse(cachedAnalysis);
      getRankedVideos(
        cachedAnalysis.generalizedTags,
        cachedAnalysis.specializedTags,
        videoId
      );
      return "CACHE_FOUND";
    }

    try {
      const dbResponse = await checkDatabaseAnalysis(videoId);
      if (dbResponse) {
        if (dbResponse.notSafe) {
          throw new Error("🚨 Transcript is not safe for analysis 🚨");
        } else if (dbResponse.tooLarge) {
          throw new Error("🚫 Transcript is too large for analysis 🚫");
        } else {
          return dbResponse;
        }
      }
    } catch (error) {
      console.error("Error fetching analysis from MongoDB:", error);
    }

    showTranscriptButton.click();

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const transcriptSegments = document.querySelectorAll(
          "ytd-transcript-segment-renderer .segment-text"
        );
        if (transcriptSegments.length > 0) {
          observer.disconnect();
          const transcriptText = Array.from(transcriptSegments)
            .map((segment) => segment.textContent.trim())
            .join("\n");
          resolve(transcriptText);
        }
      });
      observer.observe(document, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error("Transcript loading timed out."));
      }, 5000);
    });
  }

  async function getCachedAnalysis(videoId) {
    return new Promise((resolve) => {
      chrome.storage.local.get([videoId], (result) => {
        resolve(result[videoId] ? result[videoId].analysis : null);
      });
    });
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

  async function checkDatabaseAnalysis(videoId) {
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
      if (data.analysis && !data.analysis.noTranscript) {
        cacheDatabaseAnalysis(videoId, data.analysis);
        handleAPIResponse(data.analysis);
        getRankedVideos(
          data.analysis.generalizedTags,
          data.analysis.specializedTags,
          videoId
        );
        return "MONGO_FOUND";
      }
      if (data.analysis && data.analysis.noTranscript) {
        await deleteDbAnalysis(videoId);
      }
    }
    return null;
  }

  async function getRankedVideos(generalizedTags, specializedTags, videoId) {
    const cachedRankedVideos = await getCachedRankedVideos(videoId);
    const isDarkMode = isYouTubeDarkTheme();
    if (cachedRankedVideos) {
      createRankedVideosSection(cachedRankedVideos, isDarkMode);
      return;
    }
    try {
      const response = await fetch(
        "https://youtubelabelsbackendindia.el.r.appspot.com/get-ranked-videos",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generalizedTags, specializedTags, videoId }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log("Ranked Videos:", data.rankedVideos);
        cacheRankedVideos(videoId, data.rankedVideos);
        createRankedVideosSection(data.rankedVideos, isDarkMode);
      }
    } catch (error) {
      console.error("Error fetching ranked videos from MongoDB:", error);
    }
  }

  function cacheRankedVideos(currentVideoId, rankedVideos) {
    const cachedData = {
      rankedVideos: rankedVideos,
      timestamp: Date.now(),
      expiryTime: Date.now() + 7 * 24 * 60 * 60 * 1000, // One week in milliseconds
    };
    chrome.storage.local.set({ [`ranked_${currentVideoId}`]: cachedData });
  }

  async function getCachedRankedVideos(currentVideoId) {
    return new Promise((resolve) => {
      chrome.storage.local.get([`ranked_${currentVideoId}`], (result) => {
        const cachedData = result[`ranked_${currentVideoId}`];
        if (cachedData && Date.now() < cachedData.expiryTime) {
          resolve(cachedData.rankedVideos);
        } else {
          resolve(null);
        }
      });
    });
  }

  function cacheDatabaseAnalysis(videoId, analysis) {
    const cachedData = {
      analysis: analysis,
      timestamp: Date.now(),
    };
    chrome.storage.local.set({ [videoId]: cachedData });
  }

  async function deleteDbAnalysis(videoId) {
    await fetch(
      "https://youtubelabelsbackendindia.el.r.appspot.com/delete-db-analysis",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      }
    );
  }

  async function processVideo() {
    if (processStarted) return;
    processStarted = true;

    console.log("Process Video function running");
    // const titleElement = document.querySelector("ytd-watch-metadata #title");
    const titleElement =
      isNewYouTubeLayout() && !isTheaterMode()
        ? document.getElementById("player-container-outer")
        : document.querySelector("ytd-watch-metadata #title");
    createLoaderContainer(titleElement);
    // createReanalyseButton(titleElement);

    if (titleElement && location.hostname === "www.youtube.com") {
      const formattedTitle = document.querySelector(
        "yt-formatted-string.style-scope.ytd-watch-metadata"
      );

      try {
        const [transcript, thumbnailUrl] = await Promise.all([
          extractTranscript(),
          getBestThumbnail(getVideoId()),
        ]);

        if (transcript === "CACHE_FOUND" || transcript === "MONGO_FOUND") {
          console.log(
            `Data found in ${
              transcript === "CACHE_FOUND" ? "cache" : "MongoDB"
            }`
          );
          return;
        }

        const jsonString = JSON.stringify(transcript);
        const sizeInKB = new Blob([jsonString]).size / 1024;
        const geminiApiKey = await getApiKey();
        if (!geminiApiKey) {
          alert(
            "API key not found. Please set it up in the extension options."
          );
          chrome.runtime.sendMessage({ action: "openOptionsPage" });
          return;
        }

        try {
          const response = await fetch(
            "https://youtubelabelsbackendindia.el.r.appspot.com/analyse-text",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: formattedTitle.textContent,
                transcript: sizeInKB > 98 ? "TOO_LARGE" : transcript,
                thumbnailUrl: thumbnailUrl,
                videoId: getVideoId(),
                geminiApiKey: geminiApiKey,
              }),
            }
          );

          let json;
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            json = await response.json();
          } else {
            // If the response is not JSON, treat it as text
            const text = await response.text();
            throw new Error(text || response.statusText);
          }

          if (!response.ok) {
            throw new Error(json.error || response.statusText);
          }

          if (json.notSafe) {
            cacheAnalysis(getVideoId(), json);
            closeTranscript();
            handleAPIError(
              new Error("🚨 Transcript is not safe for analysis 🚨")
            );
            return;
          }

          if (json.tooLarge) {
            cacheAnalysis(getVideoId(), json);
            closeTranscript();
            handleAPIError(
              new Error("🚫 Transcript is too large for analysis 🚫")
            );
            return;
          }

          cacheAnalysis(getVideoId(), json);
          closeTranscript();
          getRankedVideos(
            json.generalizedTags,
            json.specializedTags,
            getVideoId()
          );
          handleAPIResponse(json);
        } catch (error) {
          console.log("Error 1:", error);
          closeTranscript();
          handleAPIError(error);
        }
      } catch (error) {
        closeTranscript();
        console.log("Error 2:", error);
        handleAPIError(error);
      }
    }
  }

  function createRankedVideosSection(rankedVideos, isDarkMode) {
    if (!elements.rankedVideosContainer) {
      elements.rankedVideosContainer = document.createElement("div");
      elements.rankedVideosContainer.id = "ranked-videos-container";
      elements.rankedVideosContainer.style.marginTop = "20px";
      elements.rankedVideosContainer.style.padding = "10px";
      elements.rankedVideosContainer.style.borderRadius = "10px";

      if (elements.sourceQueriesContainer) {
        elements.sourceQueriesContainer.insertAdjacentElement(
          "afterend",
          elements.rankedVideosContainer
        );
      }
    }

    // Clear existing content
    elements.rankedVideosContainer.innerHTML = "";

    // Create header container
    const headerContainer = document.createElement("div");
    headerContainer.style.display = "flex";
    headerContainer.style.justifyContent = "space-between";
    headerContainer.style.alignItems = "center";
    headerContainer.style.marginBottom = "5px";

    // Add the title
    const title = document.createElement("h3");
    title.textContent = "Similar Videos ✨";
    title.style.fontSize = "16px";
    title.style.margin = "0";
    headerContainer.appendChild(title);

    // Add show/hide button
    const toggleButton = document.createElement("button");
    toggleButton.textContent = "Hide";
    toggleButton.style.padding = "5px 10px";
    toggleButton.style.fontSize = "12px";
    toggleButton.style.cursor = "pointer";
    toggleButton.style.backgroundColor = isDarkMode ? "#3f3f3f" : "#fff";
    toggleButton.style.color = isDarkMode ? "#fff" : "#030303";
    toggleButton.style.border = "none";
    toggleButton.style.borderRadius = "5px";
    headerContainer.appendChild(toggleButton);

    elements.rankedVideosContainer.appendChild(headerContainer);

    // Create a container for video items
    const videoItemsContainer = document.createElement("div");
    videoItemsContainer.id = "video-items-container";
    elements.rankedVideosContainer.appendChild(videoItemsContainer);

    // Set styles based on dark mode
    elements.rankedVideosContainer.style.backgroundColor = isDarkMode
      ? "#282828"
      : "#efefee";
    title.style.color = isDarkMode ? "#fff" : "#030303";

    // Add video items
    rankedVideos.forEach((video) => {
      const videoContainer = createVideoContainer(video, isDarkMode);
      videoItemsContainer.appendChild(videoContainer);
    });

    // Toggle functionality
    toggleButton.addEventListener("click", () => {
      if (videoItemsContainer.style.display === "none") {
        videoItemsContainer.style.display = "block";
        toggleButton.textContent = "Hide";
        headerContainer.style.marginBottom = "5px";
      } else {
        videoItemsContainer.style.display = "none";
        toggleButton.textContent = "Show";
        headerContainer.style.marginBottom = "0px";
      }
    });

    elements.rankedVideosContainer.style.display = "block";

    createRequestReanalysisButton(elements.rankedVideosContainer);
  }

  function createVideoContainer(video, isDarkMode) {
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.marginBottom = "15px";
    container.style.padding = "10px";
    container.style.backgroundColor = isDarkMode ? "#3f3f3f" : "#fff";
    container.style.borderRadius = "10px";
    container.style.boxShadow = isDarkMode
      ? "0 1px 3px rgba(255,255,255,0.12)"
      : "0 1px 3px rgba(0,0,0,0.12)";

    const thumbnail = document.createElement("img");
    thumbnail.src = `https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`;
    thumbnail.style.width = "168px";
    thumbnail.style.height = "94px";
    thumbnail.style.objectFit = "cover";
    thumbnail.style.borderRadius = "10px";
    container.appendChild(thumbnail);

    const infoContainer = document.createElement("div");
    infoContainer.style.marginLeft = "10px";
    infoContainer.style.flex = "1";

    const title = document.createElement("h4");
    title.textContent = `${video.accurateTitle} 💯`;
    title.style.margin = "0 0 5px 0";
    title.style.color = isDarkMode ? "#fff" : "#030303";
    title.style.fontSize = "14px";
    infoContainer.appendChild(title);

    const label = document.createElement("p");
    label.textContent = video.label;
    label.style.backgroundColor = "#E50914";
    label.style.color = "#ffffff";
    label.style.padding = "5px";
    label.style.fontSize = "12px";
    label.style.fontWeight = "bold";
    label.style.borderRadius = "5px";
    label.style.display = "inline-block";
    infoContainer.appendChild(label);

    container.appendChild(infoContainer);

    container.addEventListener("click", () => {
      window.open(`https://www.youtube.com/watch?v=${video.videoId}`, "_blank");
    });
    container.style.cursor = "pointer";

    return container;
  }

  function cacheAnalysis(videoId, analysis) {
    const cachedData = {
      analysis: analysis,
      timestamp: Date.now(),
    };
    chrome.storage.local.set({ [videoId]: cachedData });
  }

  function createLoaderContainer(titleElement) {
    if (!elements.loaderContainer) {
      elements.loaderContainer = document.createElement("div");
      elements.loaderContainer.id = "loaderContainer";
      titleElement.insertAdjacentElement("afterend", elements.loaderContainer);
    }
    elements.loaderContainer.innerHTML = `
      <div class="bounce-loader">
        <div class="bounce1"></div>
        <div class="bounce2"></div>
        <div class="bounce3"></div>
      </div>
    `;
    elements.loaderContainer.style.display = "block";
    elements.loaderContainer.classList.add("loading");
    if (isNewYouTubeLayout() && !isTheaterMode()) {
      elements.loaderContainer.style.marginTop = "10px";
    }
  }

  function createReanalyseButton(titleElement) {
    if (!elements.reanalyseButton) {
      elements.reanalyseButton = document.createElement("button");
      elements.reanalyseButton.id = "reanalyseButton";
      elements.reanalyseButton.textContent = "Reanalyse";
      titleElement.insertAdjacentElement("afterend", elements.reanalyseButton);

      elements.reanalyseButton.style.marginTop = "10px";
      elements.reanalyseButton.style.padding = "10px";
      elements.reanalyseButton.style.backgroundColor = "#E50914";
      elements.reanalyseButton.style.color = "#FFFFFF";
      elements.reanalyseButton.style.border = "none";
      elements.reanalyseButton.style.borderRadius = "10px";
      elements.reanalyseButton.style.cursor = "pointer";
      elements.reanalyseButton.style.fontSize = "14px";
      elements.reanalyseButton.style.display = "block";

      elements.reanalyseButton.addEventListener("click", async function () {
        const videoId = getVideoId();
        chrome.storage.local.remove(videoId);
        await deleteDbAnalysis(videoId);
        window.location.reload();
      });
    }
  }

  function createRequestReanalysisButton(rankedVideosContainer) {
    if (!elements.requestReanalyseButton) {
      elements.requestReanalyseButton = document.createElement("button");
      elements.requestReanalyseButton.id = "requestReanalyseButton";
      elements.requestReanalyseButton.textContent = "Request Reanalysis ✍";
      rankedVideosContainer.insertAdjacentElement(
        "afterend",
        elements.requestReanalyseButton
      );

      const isDarkMode = isYouTubeDarkTheme();
      elements.requestReanalyseButton.style.marginTop = "10px";
      elements.requestReanalyseButton.style.marginBottom = "10px";
      elements.requestReanalyseButton.style.padding = "10px";
      elements.requestReanalyseButton.style.border = "none";
      elements.requestReanalyseButton.style.borderRadius = "10px";
      elements.requestReanalyseButton.style.cursor = "pointer";
      elements.requestReanalyseButton.style.fontSize = "14px";
      elements.requestReanalyseButton.style.display = "block";
      elements.requestReanalyseButton.classList.add(
        isDarkMode ? "youtube-dark-mode" : "youtube-light-mode"
      );

      elements.requestReanalyseButton.addEventListener(
        "click",
        async function () {
          const videoId = getVideoId();
          chrome.storage.local.remove(videoId);

          // Compose email
          const recipient = "ytlabelsdeveloper@gmail.com";
          const subject = "Request reanalysis for the video";
          const body = `Please reanalyze the following video:\nhttps://www.youtube.com/watch?v=${videoId}\n\nReason for reanalysis (optional):`;

          // Create mailto link
          const mailtoLink = `mailto:${recipient}?subject=${encodeURIComponent(
            subject
          )}&body=${encodeURIComponent(body)}`;

          // Open default email client
          window.open(mailtoLink, "_blank");
        }
      );
    }
  }

  function checkAndProcessVideo() {
    console.log("Check and Process Video");
    const videoElement = document.querySelector("video");
    if (videoElement) {
      console.log("Video found, waiting for tab to become visible");
      if (!document.hidden) {
        console.log("Tab is already visible, processing video");
        setTimeout(processVideo, 1000);
      } else {
        document.addEventListener(
          "visibilitychange",
          function onVisibilityChange() {
            if (!document.hidden) {
              console.log("Tab became visible, processing video");
              document.removeEventListener(
                "visibilitychange",
                onVisibilityChange
              );
              setTimeout(processVideo, 1000);
            }
          }
        );
      }
    } else {
      setTimeout(checkAndProcessVideo, 500);
    }
  }

  function removeRankedVideosContainer() {
    const rankedVideosContainer = document.getElementById(
      "ranked-videos-container"
    );
    if (rankedVideosContainer) {
      rankedVideosContainer.remove();
    }
  }

  function resetElements() {
    for (let key in elements) {
      if (elements[key]) {
        elements[key].remove();
        elements[key] = null;
      }
    }
    processStarted = false;
    // removeRankedVideosContainer();
  }

  function handleNavigation() {
    if (location.pathname.startsWith("/watch")) {
      resetElements();
      console.log("Timeout set to process video");
      setTimeout(checkAndProcessVideo, 1000);
    }
  }

  function isYouTubeDarkTheme() {
    if (document.documentElement.hasAttribute("dark")) {
      return true;
    }

    const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    if (darkModeQuery.matches) {
      return true;
    }

    const bodyStyles = getComputedStyle(document.body);
    const backgroundColor = bodyStyles.getPropertyValue(
      "--yt-spec-base-background"
    );

    if (backgroundColor) {
      const rgb = backgroundColor.match(/\d+/g);
      if (rgb) {
        const [r, g, b] = rgb.map(Number);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness < 128;
      }
    }

    return false;
  }

  function handleAPIResponse(json) {
    elements.loaderContainer.classList.remove("loading");
    elements.loaderContainer.style.display = "none";

    const titleElement =
      isNewYouTubeLayout() && !isTheaterMode()
        ? document.getElementById("player-container-outer")
        : document.querySelector("ytd-watch-metadata #title");
    const formattedTitle = document.querySelector(
      "yt-formatted-string.style-scope.ytd-watch-metadata"
    );

    const isDarkMode = isYouTubeDarkTheme();
    console.log("Dark mode:", isDarkMode);

    createAlternativeTitle(
      titleElement,
      formattedTitle,
      json.accurateTitle,
      isDarkMode
    );
    createDescriptionDiv(titleElement, json.summary, isDarkMode);
    createSideTextDiv(json.label, json.reasonForLabel);
    createClickbaitDiv(
      json.thumbnailAnalysis.clickbait,
      json.thumbnailAnalysis.clickbaitExplanation
    );
    createThumbnailAuthenticityDiv(
      json.thumbnailAnalysis.imageAuthenticity,
      json.thumbnailAnalysis.imageAuthenticityExplanation
    );
    createFactCheckDiv(json.factCheck, isDarkMode);
    createSourceQueries(json.sourceSearchQueries, isDarkMode);
  }

  function createAlternativeTitle(
    titleElement,
    formattedTitle,
    accurateTitle,
    isDarkMode
  ) {
    if (
      formattedTitle &&
      accurateTitle &&
      accurateTitle !== formattedTitle.textContent.trim()
    ) {
      if (!elements.alternativeTitleElement) {
        elements.alternativeTitleElement = document.createElement("div");
        elements.alternativeTitleElement.id = "alternativeTitle";
        titleElement.insertAdjacentElement(
          "afterend",
          elements.alternativeTitleElement
        );
      }
      elements.alternativeTitleElement.textContent = `(${accurateTitle} 💯)`;
      elements.alternativeTitleElement.style.fontSize = "16px";
      elements.alternativeTitleElement.style.fontWeight = "bold";
      if (isNewYouTubeLayout() && !isTheaterMode()) {
        elements.alternativeTitleElement.style.marginTop = "10px";
        elements.alternativeTitleElement.style.fontSize = "18px";
      }
      elements.alternativeTitleElement.style.color = isDarkMode
        ? "white"
        : "black";
    }
  }

  function createDescriptionDiv(titleElement, summary, isDarkMode) {
    if (!elements.descriptionDiv) {
      elements.descriptionDiv = document.createElement("div");
      elements.descriptionDiv.id = "customDescriptionDiv";
      if (elements.alternativeTitleElement) {
        elements.alternativeTitleElement.insertAdjacentElement(
          "afterend",
          elements.descriptionDiv
        );
      } else {
        titleElement.insertAdjacentElement("afterend", elements.descriptionDiv);
      }
    }
    elements.descriptionDiv.innerHTML = `<strong>Summary</strong>: ${summary}`;
    elements.descriptionDiv.style.padding = "12px";
    elements.descriptionDiv.style.marginTop = "10px";
    elements.descriptionDiv.style.fontSize = "14px";
    elements.descriptionDiv.style.borderRadius = "10px";
    elements.descriptionDiv.classList.add(
      isDarkMode ? "youtube-dark-mode" : "youtube-light-mode"
    );
  }

  function createSideTextDiv(label, reasonForLabel) {
    if (!elements.sideTextDiv) {
      elements.sideTextDiv = document.createElement("div");
      elements.sideTextDiv.id = "customSideTextDiv";
      elements.descriptionDiv.insertAdjacentElement(
        "afterend",
        elements.sideTextDiv
      );
    }

    elements.sideTextDiv.innerHTML = `<strong>${label}</strong> <span id="infoIcon" style="cursor: pointer;">ⓘ</span><span id="reasonForLabel" style="display: none;"> : ${reasonForLabel}</span>`;

    elements.sideTextDiv.style.backgroundColor = "#E50914";
    elements.sideTextDiv.style.color = "#ffffff";
    elements.sideTextDiv.style.padding = "10px";
    elements.sideTextDiv.style.marginTop = "10px";
    elements.sideTextDiv.style.fontSize = "13px";
    elements.sideTextDiv.style.borderRadius = "10px";
    elements.sideTextDiv.style.marginRight = "10px";
    elements.sideTextDiv.style.display = "inline-block";

    const infoIcon = elements.sideTextDiv.querySelector("#infoIcon");
    const reasonForLabelSpan =
      elements.sideTextDiv.querySelector("#reasonForLabel");

    infoIcon.addEventListener("click", function () {
      reasonForLabelSpan.style.display =
        reasonForLabelSpan.style.display === "none" ? "inline" : "none";
    });
  }

  function createClickbaitDiv(isClickbait, clickbaitExplanation) {
    if (isClickbait) {
      if (!elements.clickbaitDiv) {
        elements.clickbaitDiv = document.createElement("div");
        elements.clickbaitDiv.id = "clickbaitDiv";
        elements.sideTextDiv.insertAdjacentElement(
          "afterend",
          elements.clickbaitDiv
        );
      }

      elements.clickbaitDiv.innerHTML = `<strong>Clickbait Thumbnail/Title</strong> <span id="clickbaitIcon" style="cursor: pointer;">ⓘ</span><span id="clickbaitText" style="display: none;"> : ${clickbaitExplanation}</span>`;

      elements.clickbaitDiv.style.backgroundColor = "#E50914";
      elements.clickbaitDiv.style.color = "#FFFFFF";
      elements.clickbaitDiv.style.padding = "10px";
      elements.clickbaitDiv.style.marginTop = "10px";
      elements.clickbaitDiv.style.fontSize = "13px";
      elements.clickbaitDiv.style.borderRadius = "10px";
      elements.clickbaitDiv.style.marginRight = "10px";
      elements.clickbaitDiv.style.display = "inline-block";

      const clickbaitIcon =
        elements.clickbaitDiv.querySelector("#clickbaitIcon");
      const clickbaitSpan =
        elements.clickbaitDiv.querySelector("#clickbaitText");

      clickbaitIcon.addEventListener("click", function () {
        clickbaitSpan.style.display =
          clickbaitSpan.style.display === "none" ? "inline" : "none";
      });
    }
  }

  function createThumbnailAuthenticityDiv(
    imageAuthenticity,
    imageAuthenticityExplanation
  ) {
    if (imageAuthenticity !== "Authentic") {
      if (!elements.thumbnailAuthenticityDiv) {
        elements.thumbnailAuthenticityDiv = document.createElement("div");
        elements.thumbnailAuthenticityDiv.id = "thumbnailAuthenticityDiv";
        if (elements.clickbaitDiv) {
          elements.clickbaitDiv.insertAdjacentElement(
            "afterend",
            elements.thumbnailAuthenticityDiv
          );
        } else {
          elements.sideTextDiv.insertAdjacentElement(
            "afterend",
            elements.thumbnailAuthenticityDiv
          );
        }
      }

      elements.thumbnailAuthenticityDiv.innerHTML = `<strong>${imageAuthenticity} Thumbnail</strong> <span id="thumbnailAuthenticityIcon" style="cursor: pointer;">ⓘ</span><span id="thumbnailAuthenticityText" style="display: none;"> : ${imageAuthenticityExplanation}</span>`;

      elements.thumbnailAuthenticityDiv.style.backgroundColor = "#E50914";
      elements.thumbnailAuthenticityDiv.style.color = "#FFFFFF";
      elements.thumbnailAuthenticityDiv.style.padding = "10px";
      elements.thumbnailAuthenticityDiv.style.marginTop = "10px";
      elements.thumbnailAuthenticityDiv.style.fontSize = "13px";
      elements.thumbnailAuthenticityDiv.style.borderRadius = "10px";
      elements.thumbnailAuthenticityDiv.style.marginRight = "10px";
      elements.thumbnailAuthenticityDiv.style.display = "inline-block";

      const thumbnailAuthenticityIcon =
        elements.thumbnailAuthenticityDiv.querySelector(
          "#thumbnailAuthenticityIcon"
        );
      const thumbnailAuthenticitySpan =
        elements.thumbnailAuthenticityDiv.querySelector(
          "#thumbnailAuthenticityText"
        );

      thumbnailAuthenticityIcon.addEventListener("click", function () {
        thumbnailAuthenticitySpan.style.display =
          thumbnailAuthenticitySpan.style.display === "none"
            ? "inline"
            : "none";
      });
    }
  }

  function createFactCheckDiv(factCheck, isDarkMode) {
    if (!elements.factCheckDiv) {
      elements.factCheckDiv = document.createElement("div");
      elements.factCheckDiv.id = "factCheckDiv";
      if (elements.thumbnailAuthenticityDiv) {
        elements.thumbnailAuthenticityDiv.insertAdjacentElement(
          "afterend",
          elements.factCheckDiv
        );
      } else if (elements.clickbaitDiv) {
        elements.clickbaitDiv.insertAdjacentElement(
          "afterend",
          elements.factCheckDiv
        );
      } else {
        elements.sideTextDiv.insertAdjacentElement(
          "afterend",
          elements.factCheckDiv
        );
      }
    }

    elements.factCheckDiv.innerHTML = `<strong>Fact-check</strong> <span id="factCheckIcon" style="cursor: pointer;">ⓘ</span><span id="factCheckText" style="display: none;"> : ${factCheck}</span>`;

    elements.factCheckDiv.style.padding = "10px";
    elements.factCheckDiv.style.marginTop = "10px";
    elements.factCheckDiv.style.fontSize = "13px";
    elements.factCheckDiv.style.borderRadius = "10px";
    elements.factCheckDiv.style.display = "inline-block";
    elements.factCheckDiv.classList.add(
      isDarkMode ? "youtube-dark-mode" : "youtube-light-mode"
    );

    const factCheckIcon = elements.factCheckDiv.querySelector("#factCheckIcon");
    const factCheckSpan = elements.factCheckDiv.querySelector("#factCheckText");

    factCheckIcon.addEventListener("click", function () {
      factCheckSpan.style.display =
        factCheckSpan.style.display === "none" ? "inline" : "none";
    });
  }

  function createSourceQueries(sourceSearchQueries, isDarkMode) {
    if (sourceSearchQueries && sourceSearchQueries.length > 0) {
      if (!elements.sourceQueriesHeading) {
        elements.sourceQueriesHeading = document.createElement("div");
        elements.sourceQueriesHeading.id = "sourceQueriesHeading";
      }
      if (!elements.sourceQueriesContainer) {
        elements.sourceQueriesContainer = document.createElement("div");
        elements.sourceQueriesContainer.id = "sourceQueriesContainer";
      }

      elements.sourceQueriesHeading.innerHTML = `🌐 <strong>Relevant search queries:</strong>`;
      elements.sourceQueriesHeading.classList.add("source-queries-heading");
      elements.factCheckDiv.insertAdjacentElement(
        "afterend",
        elements.sourceQueriesHeading
      );

      elements.sourceQueriesContainer.innerHTML = sourceSearchQueries
        .map(
          (query, index) => `
        <a href="https://www.google.com/search?q=${encodeURIComponent(
          query
        )}" id="sourceQuery${index}" target="_blank">
          <strong>${query}</strong>
        </a>
      `
        )
        .join("");

      elements.sourceQueriesContainer.querySelectorAll("a").forEach((link) => {
        link.classList.add("source-query");
        link.classList.add(
          isDarkMode ? "youtube-dark-mode" : "youtube-light-mode"
        );
      });

      elements.sourceQueriesContainer.style.marginBottom = "10px";
      elements.sourceQueriesHeading.insertAdjacentElement(
        "afterend",
        elements.sourceQueriesContainer
      );
    }
  }

  function handleAPIError(error) {
    const isDarkMode = isYouTubeDarkTheme();
    console.error("API Error:", error);
    elements.loaderContainer.classList.remove("loading");
    elements.loaderContainer.style.display = "none";
    const titleElement = document.querySelector("ytd-watch-metadata #title");

    if (!elements.errorContainer) {
      elements.errorContainer = document.createElement("div");
      elements.errorContainer.id = "errorContainer";
      titleElement.insertAdjacentElement("afterend", elements.errorContainer);
    }
    elements.errorContainer.textContent = `${error.message}`;
    elements.errorContainer.style.fontSize = "14px";
    elements.errorContainer.style.color = isDarkMode ? "white" : "black";
  }

  function closeTranscript() {
    const closeButton = document.querySelector(
      'button[aria-label="Close transcript"]'
    );
    if (closeButton) {
      closeButton.click();
      // const button = document.getElementById("visibility-button");
      // if (button) {
      //   const clickableButton = button.querySelector("button");
      //   if (clickableButton) {
      //     clickableButton.click();
      //     console.log("Button clicked successfully");
      //   } else {
      //     console.log("Clickable button not found within the container");
      //   }
      // } else {
      //   console.log("Button container not found");
      // }
    } else {
      console.error("Close button not found. Transcript cannot be closed.");
    }
  }

  window.addEventListener("yt-navigate-finish", handleNavigation);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes" && mutation.attributeName === "href") {
        handleNavigation();
      }
    });
  });

  observer.observe(document.body, {
    attributes: true,
    childList: false,
    subtree: false,
    attributeFilter: ["href"],
  });

  handleNavigation();
}

extractAndDisplayInfo();
