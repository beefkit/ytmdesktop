(function () {
  console.log("[Lidarr] Album library action script loaded");

  // Track albums we've already notified about to avoid duplicates in the same session
  const notifiedAlbums = new Set();

  function isAlbumPage() {
    const path = window.location.pathname;
    // Album pages show as /playlist with an OLAK5uy_ playlist ID in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const listId = urlParams.get("list");
    const isAlbum = path === "/playlist" && listId && listId.startsWith("OLAK5uy_");
    console.log("[Lidarr] isAlbumPage check - path:", path, "listId:", listId, "isAlbum:", isAlbum);
    return isAlbum;
  }

  function isAlbumLikeAction(args) {
    // Check if this is a like action on an album playlist (OLAK5uy_ prefix)
    if (args && args[1] && args[1].likeEndpoint) {
      const playlistId = args[1].likeEndpoint.target?.playlistId;
      const isAlbumLike = playlistId && playlistId.startsWith("OLAK5uy_") && args[1].likeEndpoint.status === "LIKE";
      console.log("[Lidarr] isAlbumLikeAction - playlistId:", playlistId, "status:", args[1].likeEndpoint.status, "isAlbumLike:", isAlbumLike);
      return isAlbumLike;
    }
    return false;
  }

  function getAlbumId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("list");
  }

  function extractAlbumInfo() {
    // Try to get album title from the header
    const headerElement = document.querySelector("ytmusic-immersive-header-renderer, ytmusic-responsive-header-renderer");
    if (!headerElement) {
      return null;
    }

    // Album title is in the title element
    const titleElement = headerElement.querySelector(".title, h2.title");
    const albumTitle = titleElement?.textContent?.trim();

    // Artist is usually the first link in the subtitle/strapline
    const subtitleElement = headerElement.querySelector(".subtitle, .strapline-text");
    let artistName = null;

    if (subtitleElement) {
      // First try to get artist from a link
      const artistLink = subtitleElement.querySelector("a");
      if (artistLink) {
        artistName = artistLink.textContent?.trim();
      } else {
        // Fall back to first text content
        const runs = subtitleElement.querySelectorAll("yt-formatted-string");
        if (runs.length > 0) {
          artistName = runs[0].textContent?.trim();
        }
      }
    }

    if (!albumTitle || !artistName) {
      return null;
    }

    return {
      album: albumTitle,
      artist: artistName,
      albumId: getAlbumId()
    };
  }

  // Listen for yt-action events that indicate a library action
  window.addEventListener("yt-action", e => {
    // Only process service requests with feedback endpoint
    if (e.detail.actionName !== "yt-service-request") {
      return;
    }

    console.log("[Lidarr] yt-service-request detected");
    console.log("[Lidarr] args[1]:", JSON.stringify(e.detail.args[1], null, 2));

    // Check if this is a feedback endpoint (library add/remove action)
    // Could be in args[1] or nested differently
    const hasFeedback = e.detail.args && e.detail.args[1] && (
      e.detail.args[1].feedbackEndpoint ||
      e.detail.args[1].likeEndpoint ||
      e.detail.args[1].playlistEditEndpoint
    );

    // Check if this is an album like action (adding album to library)
    if (!isAlbumLikeAction(e.detail.args)) {
      // Not an album like action, skip
      if (!hasFeedback) {
        console.log("[Lidarr] Not a feedback/library endpoint, skipping");
      }
      return;
    }

    console.log("[Lidarr] Album like action detected!");

    // Get album ID from the event itself
    const albumId = e.detail.args[1].likeEndpoint.target.playlistId;
    console.log("[Lidarr] Album ID:", albumId);

    // Check if we've already notified about this album in this session
    if (notifiedAlbums.has(albumId)) {
      console.log("[Lidarr] Already notified about this album");
      return;
    }

    // Small delay to ensure the action completes and we can get accurate state
    setTimeout(() => {
      const albumInfo = extractAlbumInfo();
      console.log("[Lidarr] Extracted album info:", albumInfo);
      if (albumInfo) {
        notifiedAlbums.add(albumId);
        console.log("[Lidarr] Sending to main process:", albumInfo);
        window.ytmd.sendAlbumAddedToLibrary(albumInfo);
      } else {
        console.log("[Lidarr] Could not extract album info");
      }
    }, 500);
  });
})
