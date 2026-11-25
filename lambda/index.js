'use strict';
const Alexa = require('ask-sdk-core');
const { ABS_API_KEY, SERVER_URL, baseheaders, resolveBackgroundUrl } = require('./lib/settings');
const { calculateCurrentTime, getCurrentTrackByBookTime, getCurrentTrackIndexByBookTime,
  getCurrentChapterByBookTime, getTrackAndOffsetFromBookTime, isoDurationToMilliseconds,
  sanitizeForSSML } = require('./lib/audio');
const { timers, timestamps, clearTimers, resetTimestamps } = require('./lib/timers');
const { getEntityData, fuzzyMatch, fuzzyStringMatch, searchBookWithAbsAPI, amazonCrossmatch,
  searchByTitleOnly } = require('./lib/search');
const { getRecentLibraryItems, getLastPlayedLibraryItem, getItemById, startUserPlaySession, getExistingUserPlaySession,
  updateMediaProgress, updateUserPlaySession, closeUserPlaySession, getCoverUrl,
  getLibraryFilterData, getAllLibraries, getAllAudiobooks, getLibraryItems, getAuthor,
  searchFor } = require('./lib/abs-client');
const { createPlaybackToken, createPlaybackInstanceToken,
  parsePlaybackToken } = require('./lib/playback-token');
const { formatSpokenList } = require('./lib/speech');

let localSessionAttributes = {
  playbackOwnerKey: null,
  userPlaySessionID: null,
  userPlaySession: null,
  offsetInMilliseconds: null,
  amazonToken: null,
  playUrl: null,
  currentBookTime: 0,
  nextStreamEnqueued: false
};
const recentlyClosedSessionIds = new Set();

function rememberClosedSession(sessionId) {
  if (!sessionId) return;
  recentlyClosedSessionIds.add(sessionId);
  if (recentlyClosedSessionIds.size > 20) {
    recentlyClosedSessionIds.delete(recentlyClosedSessionIds.values().next().value);
  }
}

function playbackOwnerKey(handlerInput) {
  return handlerInput.requestEnvelope.context?.System?.user?.userId
    || handlerInput.requestEnvelope.session?.user?.userId
    || null;
}

function hasAlexaSession(handlerInput) {
  return Boolean(handlerInput.requestEnvelope.session);
}

function getAlexaSessionAttributes(handlerInput) {
  return hasAlexaSession(handlerInput)
    ? (handlerInput.attributesManager.getSessionAttributes() || {})
    : {};
}

function clearAlexaSessionAttributes(handlerInput) {
  if (hasAlexaSession(handlerInput)) {
    handlerInput.attributesManager.setSessionAttributes({});
  }
}

function incomingPlayerState(handlerInput) {
  const request = handlerInput.requestEnvelope.request || {};
  const player = handlerInput.requestEnvelope.context?.AudioPlayer || {};
  const currentPlaybackState = request.type === 'AudioPlayer.PlaybackFailed'
    && request.currentPlaybackState?.token
    && request.currentPlaybackState.playerActivity !== 'IDLE'
    ? request.currentPlaybackState
    : null;
  const rawToken = currentPlaybackState?.token ?? request.token ?? player.token ?? null;
  return {
    rawToken,
    token: parsePlaybackToken(rawToken),
    offsetInMilliseconds: currentPlaybackState?.offsetInMilliseconds
      ?? request.offsetInMilliseconds
      ?? player.offsetInMilliseconds
      ?? null
  };
}

function isUsablePlaySession(value) {
  return Boolean(value?.libraryItemId && value?.id && Array.isArray(value.audioTracks) && value.audioTracks.length);
}

function recoverPlaybackState(handlerInput, { allowSessionReplacement = true } = {}) {
  const sessionAttributes = getAlexaSessionAttributes(handlerInput);
  const player = incomingPlayerState(handlerInput);
  const ownerKey = playbackOwnerKey(handlerInput);
  const ownedLocalAttributes = !localSessionAttributes.playbackOwnerKey
    || localSessionAttributes.playbackOwnerKey === ownerKey
    ? localSessionAttributes
    : {};
  let userPlaySession = sessionAttributes.userPlaySession || ownedLocalAttributes.userPlaySession;

  if (player.token?.libraryItemId && userPlaySession?.libraryItemId !== player.token.libraryItemId) {
    userPlaySession = null;
  }

  if (!isUsablePlaySession(userPlaySession) && player.token?.libraryItemId) {
    if (player.token.sessionId && recentlyClosedSessionIds.has(player.token.sessionId)) {
      console.log("Playback recovery: ignoring a callback for a session already closed in this container");
      return null;
    }
    if (player.token.sessionId) {
      try {
        userPlaySession = getExistingUserPlaySession(player.token.sessionId);
      } catch (error) {
        console.log(`Playback recovery: ABS session unavailable (${error.message})`);
      }
    }
    if (!isUsablePlaySession(userPlaySession) && allowSessionReplacement) {
      userPlaySession = startUserPlaySession(player.token.libraryItemId, handlerInput);
    }
  }

  if (!isUsablePlaySession(userPlaySession)) return null;
  delete userPlaySession.libraryItem;

  const fallbackToken = parsePlaybackToken(sessionAttributes.streamToken)
    || parsePlaybackToken(ownedLocalAttributes.streamToken)
    || parsePlaybackToken(sessionAttributes.amazonToken)
    || parsePlaybackToken(ownedLocalAttributes.amazonToken);
  const trackIndex = player.token?.trackIndex || fallbackToken?.trackIndex
    || getCurrentTrackIndexByBookTime(userPlaySession.currentTime || 0, userPlaySession);
  const currentTrack = userPlaySession.audioTracks.find((track) => track.index == trackIndex);
  if (!currentTrack) throw new Error(`Playback token refers to missing track ${trackIndex}`);

  const attributes = { ...ownedLocalAttributes, ...sessionAttributes };
  attributes.playbackOwnerKey = ownerKey;
  attributes.userPlaySession = userPlaySession;
  attributes.userPlaySessionID = userPlaySession.id;
  attributes.amazonToken = trackIndex;
  attributes.currentTrackIndex = trackIndex;
  attributes.currentTrack = currentTrack;
  attributes.streamToken = player.rawToken && player.token
    ? player.rawToken
    : attributes.streamToken || createPlaybackToken(userPlaySession, trackIndex);
  attributes.playUrl = SERVER_URL + currentTrack.contentUrl + "?token=" + ABS_API_KEY;
  if (typeof attributes.nextStreamEnqueued !== 'boolean') attributes.nextStreamEnqueued = false;
  if (player.offsetInMilliseconds !== null) {
    attributes.offsetInMilliseconds = player.offsetInMilliseconds;
  } else if (!Number.isFinite(attributes.offsetInMilliseconds)) {
    attributes.offsetInMilliseconds = 0;
  }

  updateLocalSessionAttributes(attributes);
  return {
    attributes,
    userPlaySession,
    trackIndex,
    rawToken: player.rawToken,
    offsetInMilliseconds: attributes.offsetInMilliseconds
  };
}

function noActivePlaybackResponse(handlerInput) {
  return handlerInput.responseBuilder
    .speak(sanitizeForSSML('Please ask me to play an audiobook first.'))
    .withShouldEndSession(true)
    .getResponse();
}

function elapsedListeningSeconds(userPlaySession, currentBookTime) {
  if (userPlaySession?.alexaPlaybackConfirmed === false) return 0;
  const listeningStartedAt = Number(userPlaySession?.alexaListeningStartedAt);
  const trusted = Number.isFinite(listeningStartedAt);
  const since = trusted ? listeningStartedAt : Number(userPlaySession?.updatedAt);
  if (!Number.isFinite(since)) return 0;
  const elapsed = Math.max(0, (Date.now() - since) / 1000);

  const advanced = Number(currentBookTime) - Number(userPlaySession?.currentTime);
  if (!Number.isFinite(advanced)) return trusted ? elapsed : 0;
  return Math.min(elapsed, Math.max(0, advanced));
}

function saveProgressWithoutSession(userPlaySession, currentBookTime) {
  if (!userPlaySession?.libraryItemId) return false;
  try {
    updateMediaProgress(userPlaySession.libraryItemId, userPlaySession.episodeId || null, {
      currentTime: Number(currentBookTime),
      duration: Number(userPlaySession.duration) || undefined,
    });
    console.log(`Saved ${currentBookTime} seconds to media progress for ${userPlaySession.libraryItemId}`);
    return true;
  } catch (error) {
    console.error(`Could not save media progress: ${error.message}`);
    return false;
  }
}

function absSessionIsGone(userPlaySession, error) {
  if (error.statusCode !== 404) return false;
  console.log("ABS no longer has this play session; falling back to media progress");
  userPlaySession.absSessionMissing = true;
  return true;
}

function syncPlaybackProgress(userPlaySession, currentBookTime,
  { timeListened, continueListening = false } = {}) {
  let saved = false;
  if (userPlaySession?.absSessionMissing) {
    saved = saveProgressWithoutSession(userPlaySession, currentBookTime);
  } else {
    try {
      const listened = timeListened ?? elapsedListeningSeconds(userPlaySession, currentBookTime);
      updateUserPlaySession(userPlaySession, currentBookTime, listened);
      saved = true;
    } catch (error) {
      console.error(`Could not sync ABS playback progress: ${error.message}`);
      if (absSessionIsGone(userPlaySession, error)) {
        saved = saveProgressWithoutSession(userPlaySession, currentBookTime);
      }
    }
  }
  if (!saved) return false;
  userPlaySession.currentTime = currentBookTime;
  userPlaySession.updatedAt = Date.now();
  userPlaySession.alexaPlaybackConfirmed = continueListening;
  userPlaySession.alexaListeningStartedAt = continueListening ? Date.now() : null;
  return true;
}

function closePlaybackProgress(userPlaySession, currentBookTime) {
  let closed = false;
  if (userPlaySession?.absSessionMissing) {
    closed = saveProgressWithoutSession(userPlaySession, currentBookTime);
  } else {
    try {
      closeUserPlaySession(
        userPlaySession, currentBookTime,
        elapsedListeningSeconds(userPlaySession, currentBookTime));
      closed = true;
    } catch (error) {
      console.error(`Could not close ABS playback session: ${error.message}`);
      if (absSessionIsGone(userPlaySession, error)) {
        closed = saveProgressWithoutSession(userPlaySession, currentBookTime);
      }
    }
  }
  if (!closed) return false;
  rememberClosedSession(userPlaySession.id);
  userPlaySession.currentTime = currentBookTime;
  userPlaySession.updatedAt = Date.now();
  userPlaySession.alexaPlaybackConfirmed = false;
  userPlaySession.alexaListeningStartedAt = null;
  return true;
}

function syncProgressWithoutSession(handlerInput) {
  const player = incomingPlayerState(handlerInput);
  const token = player.token;
  if (!token?.libraryItemId || !token.trackIndex || player.offsetInMilliseconds == null) {
    console.log("Fallback progress sync: the stream token carries no position to save");
    return false;
  }
  if (token.sessionId && recentlyClosedSessionIds.has(token.sessionId)) {
    console.log("Fallback progress sync: this position was already saved when the session closed");
    return false;
  }
  try {
    const item = getItemById(token.libraryItemId, { include: ['progress'], expanded: 1 });
    const tracks = item?.media?.tracks;
    const track = Array.isArray(tracks)
      ? tracks.find((candidate) => candidate.index == token.trackIndex)
      : null;
    if (!track) throw new Error(`Library item has no track ${token.trackIndex}`);
    const currentTime = Number(track.startOffset) + player.offsetInMilliseconds / 1000;
    if (!Number.isFinite(currentTime)) throw new Error('Could not derive a book position from the stream token');

    const stored = Number(item?.userMediaProgress?.currentTime);
    if (Number.isFinite(stored) && currentTime < stored) {
      console.log(`Fallback progress sync: keeping the stored ${stored} seconds rather than moving back to ${currentTime}`);
      return false;
    }

    updateMediaProgress(token.libraryItemId, null, {
      currentTime,
      duration: Number(item.media.duration) || undefined,
    });
    console.log(`Fallback progress sync: saved ${currentTime} seconds to media progress for ${token.libraryItemId}`);
    return true;
  } catch (error) {
    console.error(`Could not save progress without a play session: ${error.message}`);
    return false;
  }
}

function sameStreamToken(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function preparePlaybackTransition(attributes, playback, previousToken, previousPositionSynced) {
  attributes.pendingStreamToken = playback.streamToken;
  attributes.supersededStreamToken = previousToken ?? null;
  attributes.supersededStreamPositionSynced = Boolean(previousPositionSynced);
  attributes.nextStreamEnqueued = false;
  attributes.userPlaySession.alexaPlaybackConfirmed = false;
  attributes.userPlaySession.alexaListeningStartedAt = null;
}

function shouldIgnoreStoppedStream(attributes, rawToken) {
  if (sameStreamToken(rawToken, attributes.supersededStreamToken)
    && attributes.supersededStreamPositionSynced) return true;

  return attributes.activeStreamToken
    && !sameStreamToken(rawToken, attributes.activeStreamToken);
}

// INTENT HANDLERS

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speakOutput = 'Welcome to Audiobookshelf, you can say "play audiobook" to start listening.';

    console.log(" ~~~ LOGGED AT END OF LaunchRequestHandler ");
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

const RecentBooksIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'RecentBooksIntent';
  },
  handle(handlerInput) {
    const recentBooks = getRecentLibraryItems(3);

    if (!recentBooks.length) {
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML("You haven't listened to any audiobooks recently."))
        .withShouldEndSession(true)
        .getResponse();
    }

    const descriptions = recentBooks.map((book) => {
      const metadata = book.media.metadata;
      return metadata.authorName
        ? `${metadata.title} by ${metadata.authorName}`
        : metadata.title;
    });
    const spokenList = formatSpokenList(descriptions);
    const speakOutput = `You've most recently listened to: ${spokenList}.`;

    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .withShouldEndSession(true)
      .getResponse();
  }
};

function resolveTargetEpisodeId(expandedItem) {
  if (expandedItem?.mediaType !== 'podcast') return null;
  const episodes = Array.isArray(expandedItem?.media?.episodes) ? expandedItem.media.episodes : [];
  if (!episodes.length) return null;

  const progressEpisodeId = !Array.isArray(expandedItem.userMediaProgress)
    ? expandedItem.userMediaProgress?.episodeId
    : null;
  if (progressEpisodeId) return progressEpisodeId;

  const sorted = [...episodes].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return sorted[0].id;
}

const PlayAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayAudioIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayLastIntent');
  },
  async handle(handlerInput) {
    try {
      let timeStart = timestamps.PlayAudioIntentHandlerStartTime = new Date();
      let userPlaySession;
      let lastPlayedLibraryItem;
      let expandedItem;
      let lastPlayedID;
      let episodeId = null;

      const playBehavior = 'REPLACE_ALL';

      let sessionAttributes = getAlexaSessionAttributes(handlerInput);
      const recoveredState = recoverPlaybackState(handlerInput);
      if (recoveredState) sessionAttributes = recoveredState.attributes;

      const existingSession = recoveredState?.userPlaySession || sessionAttributes.userPlaySession;
      let existingAttributes = (sessionAttributes && Object.keys(sessionAttributes).length > 0)
        ? sessionAttributes
        : recoveredState?.attributes || null;

      if (existingSession && existingAttributes) {
        userPlaySession = sessionAttributes.userPlaySession || localSessionAttributes.userPlaySession;
      } else {
        lastPlayedLibraryItem = getLastPlayedLibraryItem();
        lastPlayedID = lastPlayedLibraryItem.id;
        expandedItem = getItemById(lastPlayedID, { include: ['progress'], expanded: 1 });
        episodeId = resolveTargetEpisodeId(expandedItem);
      }

      if (!userPlaySession) {
        userPlaySession = startUserPlaySession(lastPlayedID, handlerInput, episodeId);
      }
      delete userPlaySession.libraryItem;

      let currentTime;
      if (!existingSession) {
        const episodeProgress = episodeId && Array.isArray(expandedItem.userMediaProgress)
          ? expandedItem.userMediaProgress.find(p => p.episodeId === episodeId)
          : expandedItem.userMediaProgress;
        currentTime = episodeProgress?.currentTime ?? 0.0;
        if (currentTime > userPlaySession.duration) {
          currentTime = 0.0;
          syncPlaybackProgress(userPlaySession, 0.0, { timeListened: 0 });
        }
      } else {
        currentTime = existingSession.currentTime;
      }

      sessionAttributes.userPlaySession = userPlaySession;
      sessionAttributes.userPlaySessionID = userPlaySession.id;

      let currentTrack = sessionAttributes.currentTrack = getCurrentTrackByBookTime(currentTime, userPlaySession);
      let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndexByBookTime(currentTime, userPlaySession);
      sessionAttributes.streamToken = createPlaybackInstanceToken(userPlaySession, currentTrackIndex);
      sessionAttributes.currentTrackIndex = currentTrackIndex;

      let trackStartOffset = currentTrack.startOffset;
      const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = (currentTime - trackStartOffset) * 1000;

      sessionAttributes.nextStreamEnqueued = false;
      const coverUrl = sessionAttributes.coverUrl = getCoverUrl(userPlaySession.libraryItemId);

      const chapterObj = getCurrentChapterByBookTime(currentTime, userPlaySession);
      const chapterTitle = chapterObj?.title || userPlaySession.displayTitle;
      const author = userPlaySession.displayAuthor;
      const bookTitle = userPlaySession.displayTitle;
      const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY;

      preparePlaybackTransition(
        sessionAttributes,
        { streamToken: sessionAttributes.streamToken },
        recoveredState?.rawToken || sessionAttributes.activeStreamToken,
        false
      );
      retainPlaybackStateLocally(handlerInput, sessionAttributes);

      let timeEnd = timestamps.PlayAudioIntentHandlerEndTime = new Date();
      console.log("TIMER: Total Intent Time (PlayAudioIntent): " + (timeEnd - timeStart) + " ms");

      const metadata = {
        title: chapterTitle,
        subtitle: bookTitle,
        art: {
          sources: [
            {
              url: coverUrl,
              widthPixels: 512,
              heightPixels: 512
            }
          ]
        },
        backgroundImage: {
          sources: [
            {
              url: resolveBackgroundUrl(coverUrl),
              widthPixels: 1600,
              heightPixels: 900
            }
          ]
        }
      };

      let speakOutput;
      if (!existingSession) {
        speakOutput = author ? `Playing ${bookTitle} by ${author}` : `Playing ${bookTitle}`;
      }
      console.log(`Playing Audiobookshelf item ${userPlaySession.libraryItemId}, track ${currentTrackIndex}`);

      return handlerInput.responseBuilder
        .speak(sanitizeForSSML(speakOutput))
        .addAudioPlayerPlayDirective(
          playBehavior,
          playUrl,
          sessionAttributes.streamToken,
          offsetInMilliseconds,
          null,
          metadata
        )
        .withShouldEndSession(true)
        .getResponse();
    } catch (error) {
      console.error("Error during PlayAudioIntentHandler: " + error);
      throw error;
    }
  }
};

const PlayBookIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayBookIntent');
  },
  async handle(handlerInput) {
    const previousState = recoverPlaybackState(handlerInput, { allowSessionReplacement: false });

    let rawAuthor = handlerInput.requestEnvelope.request.intent.slots.author.value || null;
    let rawTitle = handlerInput.requestEnvelope.request.intent.slots.title.value || null;
    const accessToken = handlerInput.requestEnvelope.context.System.apiAccessToken;
    const authorResolutions = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0] || null;
    const titleResolutions = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0] || null;
    let amazonAuthor = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name ?? null;
    let amazonTitle = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name ?? null;
    let author = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name
      ?? handlerInput.requestEnvelope.request.intent.slots.author.value;
    let bookTitle = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name
      ?? handlerInput.requestEnvelope.request.intent.slots.title.value;

    if (rawAuthor) { timers.context.authorProvided = true; }
    if (rawTitle) { timers.context.titleProvided = true; }
    timers.context.timestamp = timestamps.PlayBookIntentHandlerStartTime = new Date();

    if (!bookTitle) {
      let speakOutput = 'I did not understand the request. For example, try saying "Play audiobook title by author".';
      console.log("Book and/or author slot undefined");
      return handlerInput.responseBuilder
        .speak(speakOutput)
        .reprompt(speakOutput)
        .getResponse();
    }

    const amazonStuffStart = new Date();
    let amazonResolutionFailed = false;
    let quickFuzzyCheck = fuzzyStringMatch(bookTitle, rawTitle);
    if (!quickFuzzyCheck) {
      bookTitle = rawTitle;
      amazonTitle = null;
    }
    const quickFuzzyCheckAuthor = fuzzyStringMatch(author, rawAuthor);
    if (!quickFuzzyCheckAuthor) {
      author = rawAuthor;
      amazonAuthor = null;
    }

    if (authorResolutions && titleResolutions && authorResolutions.status.code == "ER_SUCCESS_MATCH"
      && titleResolutions.status.code == "ER_SUCCESS_MATCH") {
      const validItems = amazonCrossmatch(titleResolutions, authorResolutions, accessToken);
      if (!validItems.validAuthors.length || !validItems.validTitles.length) {
        console.log("Amazon cross match failed");
      } else {
        console.log("Amazon cross match passed! " + validItems.validTitles[0] + " by " + validItems.validAuthors[0]);
        amazonTitle = bookTitle = validItems.validTitles[0];
        amazonAuthor = author = validItems.validAuthors[0];
      }
    }

    if (amazonTitle && !amazonAuthor && bookTitle) {
      const bookUrl = handlerInput.requestEnvelope.request.intent.slots.title.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.id ?? null;
      if (bookUrl) {
        const bookData = getEntityData(bookUrl, accessToken, "en-US");
        if (bookData) {
          amazonAuthor = author = bookData["entertainment:author"][0].name[0]["@value"];
          amazonTitle = bookTitle = bookData.name[0]["@value"];
        }
      }
    }

    if (amazonAuthor && !amazonTitle && rawTitle) {
      const authorUrl = handlerInput.requestEnvelope.request.intent.slots.author.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.id ?? null;
      if (authorUrl) {
        const authorData = getEntityData(authorUrl, accessToken, "en-US");
        if (authorData) {
          const key = {
            name: 'title',
            getFn: (item) => item.name[0]["@value"]
          };
          const options = {
            searchData: authorData["entertainment:authorOf"],
            searchKey: rawTitle,
            key: key,
            threshold: 0.6,
            arrayOrBest: 'array',
            scoreThreshold: 0.4
          };

          let matchedTitles = fuzzyMatch(options);
          const matchedTitle = matchedTitles?.[0].item ?? null;
          if (matchedTitle) {
            const matchedTitleString = matchedTitle.item.name[0]["@value"];
            console.log("Found title '" + matchedTitleString + "' that correlates to author '" + amazonAuthor + "'");
            amazonTitle = bookTitle = matchedTitleString;
          }
        }
      }
    }

    if (!amazonTitle || !amazonAuthor) { amazonResolutionFailed = true; }
    if (amazonResolutionFailed) {
      console.log("Could not Amazon match '" + bookTitle + "'. Moving on to ABS search");
    }

    const amazonStuffEnd = new Date();
    const amazonElapsedTime = amazonStuffEnd - amazonStuffStart;
    console.log("TIMER: Amazon stuff: " + amazonElapsedTime + " ms");
    timers.amazonStuff = amazonElapsedTime;

    const ABSsearchStart = new Date();
    let libraryItem = null;
    let absMatchedAuthor = null;

    for (let i = 0; i < 2 && !libraryItem; i++) {
      if (i == 0) {
        if (amazonAuthor || amazonTitle) {
          console.log("Searching ABS with Amazon data");
          if (amazonAuthor) {
            author = amazonAuthor;
            console.log("Amazon author: " + amazonAuthor);
          } else {
            console.log("Raw author: " + author);
          }
          if (amazonTitle) {
            bookTitle = amazonTitle;
            console.log("Amazon title: " + amazonTitle);
          } else {
            console.log("Raw title: " + bookTitle);
          }
        } else {
          i = 1;
          bookTitle = rawTitle;
          author = rawAuthor;
          console.log("No Amazon data resolution. Start searching ABS with raw data");
        }
      } else {
        bookTitle = rawTitle;
        author = rawAuthor;
        console.log("No Amazon data resolution. Start searching ABS with raw data");
      }

      if (bookTitle && author) {
        const allLibraries = getAllLibraries();
        const bookLibraries = allLibraries.filter(library => library.mediaType === 'book');
        const audiobooksOnlyLibraries = bookLibraries.filter(library => library.settings.audiobooksOnly);
        const bookLibraryIDs = audiobooksOnlyLibraries.map(library => library.id);

        const filterdata = getLibraryFilterData(bookLibraryIDs[0]);

        const options = {
          searchData: filterdata.authors,
          searchKey: author,
          key: 'name',
          threshold: 0.6,
          arrayOrBest: 'array',
          scoreThreshold: 0.6
        };
        const absMatchedAuthors = fuzzyMatch(options);
        absMatchedAuthor = absMatchedAuthors?.[0].item;

        if (absMatchedAuthor) {
          console.log("Matched author: " + absMatchedAuthor.name + " in ABS library!");
          const authorResult = getAuthor(absMatchedAuthor.id);
          const libraryItems = authorResult.libraryItems;

          const optionsTitle = {
            searchData: libraryItems,
            searchKey: bookTitle,
            key: 'media.metadata.title',
            threshold: 0.6,
            arrayOrBest: 'array',
            scoreThreshold: 0.6
          };
          const absMatchedTitles = fuzzyMatch(optionsTitle);
          const absMatchedTitle = absMatchedTitles?.[0].item;
          libraryItem = absMatchedTitle || null;
        }
        if (!absMatchedAuthor || !libraryItem) {
          if (!absMatchedAuthor) {
            console.log("Could not find author: " + author + " in ABS library");
          }
          libraryItem = searchByTitleOnly({
            bookTitle: bookTitle,
            APIsearch: true,
            fuzzySearch: true
          });
          if (libraryItem) {
            console.log("Found an item in ABS by title search only!");
          }
        }
      } else if (bookTitle && !author) {
        libraryItem = searchByTitleOnly({
          bookTitle: bookTitle,
          APIsearch: true,
          fuzzySearch: true
        });
      }
    }

    if (libraryItem) {
      console.log("Found an item in the library!");
      console.log("Title: " + libraryItem.media.metadata.title);
      console.log("Author: " + libraryItem.media.metadata.authorName);
    } else {
      console.log("Could not find a playable item (" + rawTitle + " by " + rawAuthor + ")");
      let speakOutput = rawAuthor
        ? `Could not find a playable book or podcast matching ${rawTitle} by ${rawAuthor}. Please try again.`
        : `Could not find a playable book or podcast matching ${rawTitle}. Please try again.`;
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML(speakOutput))
        .reprompt(sanitizeForSSML(speakOutput))
        .getResponse();
    }

    const ABSsearchEnd = new Date();
    const ABSsearchTime = ABSsearchEnd - ABSsearchStart;
    console.log("TIMER: ABS search time: " + ABSsearchTime + " ms");
    timers.totalABSsearch = ABSsearchTime;

    if (previousState && previousState.offsetInMilliseconds !== null) {
      const previousBookTime = calculateCurrentTime(
        previousState.userPlaySession,
        previousState.offsetInMilliseconds,
        previousState.trackIndex
      );
      closePlaybackProgress(previousState.userPlaySession, previousBookTime);
    } else {
      syncProgressWithoutSession(handlerInput);
    }
    clearAllMemory(handlerInput);

    // START PLAYING THE BOOK OR PODCAST
    const playBehavior = 'REPLACE_ALL';
    const libraryItemID = libraryItem.id;

    let expandedItem = getItemById(libraryItemID, { include: ['progress'], expanded: 1 });
    const episodeId = resolveTargetEpisodeId(expandedItem);

    let userPlaySession = startUserPlaySession(libraryItemID, handlerInput, episodeId);
    delete userPlaySession.libraryItem;

    const sessionAttributes = getAlexaSessionAttributes(handlerInput);
    localSessionAttributes = JSON.parse(JSON.stringify(sessionAttributes));

    const episodeProgress = episodeId && Array.isArray(expandedItem.userMediaProgress)
      ? expandedItem.userMediaProgress.find(p => p.episodeId === episodeId)
      : expandedItem.userMediaProgress;

    sessionAttributes.userPlaySession = userPlaySession;
    sessionAttributes.userPlaySessionID = userPlaySession.id;

    let currentTime = episodeProgress?.currentTime ?? 0.0;
    if (currentTime > userPlaySession.duration) {
      currentTime = 0.0;
      syncPlaybackProgress(userPlaySession, currentTime, { timeListened: 0 });
    }

    let currentTrack = sessionAttributes.currentTrack = getCurrentTrackByBookTime(currentTime, userPlaySession);
    let currentTrackIndex = sessionAttributes.amazonToken = getCurrentTrackIndexByBookTime(currentTime, userPlaySession);
    sessionAttributes.streamToken = createPlaybackInstanceToken(userPlaySession, currentTrackIndex);
    sessionAttributes.currentTrackIndex = currentTrackIndex;

    let trackStartOffset = currentTrack.startOffset;
    const offsetInMilliseconds = sessionAttributes.offsetInMilliseconds = (currentTime - trackStartOffset) * 1000;

    sessionAttributes.nextStreamEnqueued = false;

    const playUrl = sessionAttributes.playUrl = SERVER_URL + userPlaySession.audioTracks[currentTrackIndex - 1].contentUrl + "?token=" + ABS_API_KEY;
    const coverUrl = getCoverUrl(userPlaySession.libraryItemId);

    preparePlaybackTransition(
      sessionAttributes,
      { streamToken: sessionAttributes.streamToken },
      null,
      false
    );
    retainPlaybackStateLocally(handlerInput, sessionAttributes);

    const authorName = userPlaySession.displayAuthor;
    const speakOutput = authorName
      ? `Playing ${userPlaySession.displayTitle} by ${authorName}`
      : `Playing ${userPlaySession.displayTitle}`;
    console.log(`Playing Audiobookshelf item ${userPlaySession.libraryItemId}, track ${currentTrackIndex}`);

    const chapterObj = getCurrentChapterByBookTime(currentTime, userPlaySession);
    const chapterTitle = chapterObj?.title || userPlaySession.displayTitle;
    const subtitle = userPlaySession.displayTitle;

    const metadata = {
      title: chapterTitle,
      subtitle: subtitle,
      art: {
        sources: [
          {
            url: coverUrl,
            widthPixels: 512,
            heightPixels: 512
          }
        ]
      },
      backgroundImage: {
        sources: [
          {
            url: resolveBackgroundUrl(coverUrl),
            widthPixels: 1600,
            heightPixels: 900
          }
        ]
      }
    };

    const timeBeforeResponse = timestamps.PlayBookIntentHandlerEndTime = new Date();
    const timeUntilResponse = timeBeforeResponse - ABSsearchEnd;
    const totalIntentTime = timeBeforeResponse - amazonStuffStart;
    console.log("TIMER: Time after ABS search until skill response: " + timeUntilResponse + " ms");
    console.log("TIMER: Total intent time (PlayBookIntent): " + totalIntentTime + " ms");
    timers.totalIntentTime = totalIntentTime;
    timers.preparePlay = timeUntilResponse;
    clearTimers();

    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .addAudioPlayerPlayDirective(
        playBehavior,
        playUrl,
        sessionAttributes.streamToken,
        offsetInMilliseconds,
        null,
        metadata
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const PauseAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent';
  },
  async handle(handlerInput) {
    try {
      const state = recoverPlaybackState(handlerInput, { allowSessionReplacement: false });
      if (state && state.offsetInMilliseconds !== null) {
        const { attributes: sessionAttributes, userPlaySession,
          offsetInMilliseconds, trackIndex } = state;
        const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex);

        const currentPositionSynced = syncPlaybackProgress(userPlaySession, currentBookTime);
        sessionAttributes.supersededStreamToken = state.rawToken;
        sessionAttributes.supersededStreamPositionSynced = currentPositionSynced;

        retainPlaybackStateLocally(handlerInput, sessionAttributes);
      } else {
        console.log("PauseAudioIntentHandler: no ABS session to sync; saving the position directly");
        syncProgressWithoutSession(handlerInput);
      }
      return handlerInput.responseBuilder
        .addAudioPlayerStopDirective()
        .withShouldEndSession(true)
        .getResponse();
    } catch (error) {
      console.error(`PauseAudioIntentHandler: could not sync progress (${error.message})`);
      return handlerInput.responseBuilder
        .addAudioPlayerStopDirective()
        .withShouldEndSession(true)
        .getResponse();
    }
  }
};

const PreviousIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PreviousIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput);
    if (!state) return noActivePlaybackResponse(handlerInput);
    const { attributes: sessionAttributes, userPlaySession, offsetInMilliseconds, trackIndex, rawToken } = state;

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex);
    const currentPositionSynced = syncPlaybackProgress(
      userPlaySession, currentBookTime, { continueListening: true });

    const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession);
    const chapterIndex = userPlaySession.chapters.indexOf(currentChapter);
    const previousChapter = chapterIndex > 0 ? userPlaySession.chapters[chapterIndex - 1] : null;
    const targetChapter = currentBookTime > currentChapter.start + 5
      ? currentChapter
      : (previousChapter || userPlaySession.chapters[0]);
    const newBookTime = targetChapter.start;
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, newBookTime);
    preparePlaybackTransition(sessionAttributes, playback, rawToken, currentPositionSynced);
    retainPlaybackStateLocally(handlerInput, sessionAttributes);

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, newBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const NextIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NextIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput);
    if (!state) return noActivePlaybackResponse(handlerInput);
    const { attributes: sessionAttributes, userPlaySession, offsetInMilliseconds, trackIndex, rawToken } = state;
    const chapters = userPlaySession.chapters;

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex);
    const currentPositionSynced = syncPlaybackProgress(
      userPlaySession, currentBookTime, { continueListening: true });

    const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession);
    const chapterIndex = chapters.indexOf(currentChapter);
    const nextChapter = chapters[chapterIndex + 1];
    if (!nextChapter) {
      console.log('NextIntent: already in the final chapter');
      retainPlaybackStateLocally(handlerInput, sessionAttributes);
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML('This is the last chapter of ' + userPlaySession.displayTitle + '.'))
        .withShouldEndSession(true)
        .getResponse();
    }
    const newBookTime = nextChapter.start;
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, newBookTime);
    preparePlaybackTransition(sessionAttributes, playback, rawToken, currentPositionSynced);
    retainPlaybackStateLocally(handlerInput, sessionAttributes);

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, newBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const GoToChapterXIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoToChapterX';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput);
    if (!state) return noActivePlaybackResponse(handlerInput);

    const { attributes: sessionAttributes, userPlaySession,
      offsetInMilliseconds, trackIndex, rawToken } = state;
    const chapters = Array.isArray(userPlaySession.chapters) ? userPlaySession.chapters : [];
    const rawChapterNumber = handlerInput.requestEnvelope.request.intent.slots.chapterNumber?.value;
    const chapterNumber = Number(rawChapterNumber);

    if (chapters.length === 0) {
      retainPlaybackStateLocally(handlerInput, sessionAttributes);
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML('This audiobook does not include chapter information.'))
        .withShouldEndSession(true)
        .getResponse();
    }

    if (!Number.isInteger(chapterNumber) || chapterNumber < 1 || chapterNumber > chapters.length) {
      retainPlaybackStateLocally(handlerInput, sessionAttributes);
      return handlerInput.responseBuilder
        .speak(sanitizeForSSML(`Please choose a chapter between 1 and ${chapters.length}.`))
        .withShouldEndSession(true)
        .getResponse();
    }

    const targetChapter = chapters[chapterNumber - 1];
    const newBookTime = targetChapter.start;
    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, trackIndex);
    const currentPositionSynced = syncPlaybackProgress(
      userPlaySession, currentBookTime, { continueListening: true });
    const playback = applyBookTimeToAttributes(
      sessionAttributes, userPlaySession, newBookTime);
    preparePlaybackTransition(sessionAttributes, playback, rawToken, currentPositionSynced);
    retainPlaybackStateLocally(handlerInput, sessionAttributes);

    console.log(`GoToChapterX: chapter ${chapterNumber} starts at ${newBookTime} seconds`);
    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(`Going to chapter ${chapterNumber}.`))
      .addAudioPlayerPlayDirective(
        'REPLACE_ALL',
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, newBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const GoBackXTimeIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoBackXTimeIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput);
    if (!state) return noActivePlaybackResponse(handlerInput);
    const { attributes: sessionAttributes, userPlaySession,
      offsetInMilliseconds: currentOffsetInMilliseconds, trackIndex: currentToken } = state;

    const beforeBookTime = calculateCurrentTime(userPlaySession, currentOffsetInMilliseconds, currentToken);
    const currentPositionSynced = syncPlaybackProgress(
      userPlaySession, beforeBookTime, { continueListening: true });
    const timeCode = handlerInput.requestEnvelope.request.intent.slots.time.value;
    const milliseconds = isoDurationToMilliseconds(timeCode);
    const afterBookTime = Math.max(0, beforeBookTime - milliseconds / 1000);
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, afterBookTime);
    preparePlaybackTransition(sessionAttributes, playback, state.rawToken, currentPositionSynced);
    console.log("Before skip: " + beforeBookTime + " seconds");
    console.log("After skip: " + afterBookTime + " seconds");

    retainPlaybackStateLocally(handlerInput, sessionAttributes);

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, afterBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const GoForwardXTimeIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GoForwardXTimeIntent';
  },
  async handle(handlerInput) {
    const state = recoverPlaybackState(handlerInput);
    if (!state) return noActivePlaybackResponse(handlerInput);
    const { attributes: sessionAttributes, userPlaySession,
      offsetInMilliseconds: currentOffsetInMilliseconds, trackIndex: currentToken } = state;

    const timeCode = handlerInput.requestEnvelope.request.intent.slots.time.value;
    const milliseconds = isoDurationToMilliseconds(timeCode);
    const beforeBookTime = calculateCurrentTime(userPlaySession, currentOffsetInMilliseconds, currentToken);
    const currentPositionSynced = syncPlaybackProgress(
      userPlaySession, beforeBookTime, { continueListening: true });
    const requestedBookTime = beforeBookTime + milliseconds / 1000;
    const afterBookTime = requestedBookTime >= userPlaySession.duration
      ? Math.max(0, userPlaySession.duration - 5)
      : requestedBookTime;
    const playback = applyBookTimeToAttributes(sessionAttributes, userPlaySession, afterBookTime);
    preparePlaybackTransition(sessionAttributes, playback, state.rawToken, currentPositionSynced);
    console.log("Before skip: " + beforeBookTime + " seconds");
    console.log("After skip: " + afterBookTime + " seconds");
    console.log("Seconds skipped: " + (parseInt(afterBookTime) - parseInt(beforeBookTime)).toString() + " seconds");

    retainPlaybackStateLocally(handlerInput, sessionAttributes);

    return handlerInput.responseBuilder
      .addAudioPlayerPlayDirective(
        "REPLACE_ALL",
        playback.playUrl,
        playback.streamToken,
        playback.offsetInMilliseconds,
        null,
        buildPlaybackMetadata(userPlaySession, afterBookTime)
      )
      .withShouldEndSession(true)
      .getResponse();
  }
};

const UnsupportedAudioIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (
        Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.LoopOffIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.LoopOnIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.RepeatIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ShuffleOffIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ShuffleOnIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StartOverIntent'
      );
  },
  async handle(handlerInput) {
    const speakOutput = 'Sorry, I can\'t support that yet.';

    return handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    const speakOutput = 'You can say "play audio" to start playing your book! How can I help?';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    const speakOutput = 'Goodbye!';
    let state = null;
    let closed = false;

    try {
      state = recoverPlaybackState(handlerInput, { allowSessionReplacement: false });
      if (state && state.offsetInMilliseconds !== null) {
        const currentBookTime = calculateCurrentTime(
          state.userPlaySession, state.offsetInMilliseconds, state.trackIndex);
        closed = closePlaybackProgress(state.userPlaySession, currentBookTime);
        if (!closed) {
          state.attributes.pendingClose = true;
          retainPlaybackStateLocally(handlerInput, state.attributes);
        }
      } else {
        console.log("CancelAndStopIntentHandler: no recoverable playback state");
        syncProgressWithoutSession(handlerInput);
      }
    } catch (error) {
      console.error(`CancelAndStopIntentHandler: could not close ABS session (${error.message})`);
    }
    console.log("CancelAndStopIntentHandler: closing Alexa skill");
    const response = handlerInput.responseBuilder
      .speak(sanitizeForSSML(speakOutput))
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
    if (!state || closed) clearAllMemory(handlerInput);
    else clearAlexaSessionAttributes(handlerInput);
    return response;
  }
};

const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type.startsWith('AudioPlayer.');
  },
  async handle(handlerInput) {
    let audioPlayerEventName;
    let audioPlayerEventStartTime;
    try {
      audioPlayerEventStartTime = timestamps.AudioPlayerEventHandlerStartTime = new Date();
      audioPlayerEventName = handlerInput.requestEnvelope.request.type.split('.')[1];
      console.log(`AudioPlayer event encountered: ${handlerInput.requestEnvelope.request.type}`);

      const state = recoverPlaybackState(handlerInput, { allowSessionReplacement: false });
      const offset = state?.offsetInMilliseconds;
      const amazonToken = state?.trackIndex;
      const streamToken = state?.rawToken || state?.attributes.streamToken;
      const attributes = state?.attributes;
      const userPlaySession = state?.userPlaySession;
      let currentBookTime;
      let audioResponse;
      if (!userPlaySession || offset == null || amazonToken == null) {
        console.log("userPlaySession, offset, or amazonToken was undefined; cannot sync progress");
        if (audioPlayerEventName !== 'PlaybackStarted') {
          syncProgressWithoutSession(handlerInput);
        }
      } else {
        currentBookTime = calculateCurrentTime(userPlaySession, offset, amazonToken);
      }

      switch (audioPlayerEventName) {
        case 'PlaybackStarted': {
          console.log("PlaybackStarted");
          const PlaybackStartedTime = new Date();
          if (timestamps.PlayAudioIntentHandlerStartTime) {
            console.log("TIMER: Time from PlayAudioIntentHandlerStart to PlaybackStarted: " + (PlaybackStartedTime - timestamps.PlayAudioIntentHandlerStartTime) + " ms");
          }
          if (timestamps.PlayBookIntentHandlerStartTime) {
            console.log("TIMER: Time from PlayBookIntentHandlerStart to PlaybackStarted: " + (PlaybackStartedTime - timestamps.PlayBookIntentHandlerStartTime) + " ms");
          }

          if (userPlaySession && currentBookTime !== undefined) {
            syncPlaybackProgress(userPlaySession, currentBookTime, {
              timeListened: 0,
              continueListening: true,
            });
            attributes.activeStreamToken = streamToken;
            if (sameStreamToken(streamToken, attributes.pendingStreamToken)) {
              delete attributes.pendingStreamToken;
              delete attributes.supersededStreamToken;
              delete attributes.supersededStreamPositionSynced;
            }
            attributes.nextStreamEnqueued = false;
            updateLocalSessionAttributes(attributes);
          }
          break;
        }

        case 'PlaybackFinished':
          if (attributes?.activeStreamToken
            && !sameStreamToken(streamToken, attributes.activeStreamToken)) {
            console.log("PlaybackFinished: ignored a stale finished event for the previous stream");
          } else if (attributes?.nextStreamEnqueued) {
            if (userPlaySession && currentBookTime !== undefined) {
              syncPlaybackProgress(userPlaySession, currentBookTime);
              attributes.nextStreamEnqueued = false;
              updateLocalSessionAttributes(attributes);
            }
          } else {
            if (userPlaySession && currentBookTime !== undefined
              && closePlaybackProgress(userPlaySession, currentBookTime)) {
              console.log("PlaybackFinished: synced and closed the ABS session");
              clearAllMemory(handlerInput);
            } else if (attributes) {
              attributes.pendingClose = true;
              updateLocalSessionAttributes(attributes);
            }
          }
          break;

        case 'PlaybackStopped':
          if (attributes?.pendingClose && userPlaySession && currentBookTime !== undefined) {
            if (closePlaybackProgress(userPlaySession, currentBookTime)) {
              console.log("PlaybackStopped: completed a previously failed close");
              clearAllMemory(handlerInput);
            } else {
              updateLocalSessionAttributes(attributes);
            }
          } else if (attributes && shouldIgnoreStoppedStream(attributes, streamToken)) {
            console.log("PlaybackStopped: ignored stale or already-synced stream");
          } else if (userPlaySession && currentBookTime !== undefined) {
            console.log("PlaybackStopped: syncing Alexa's reported position");
            syncPlaybackProgress(userPlaySession, currentBookTime);
            updateLocalSessionAttributes(attributes);
          }
          break;

        case 'PlaybackNearlyFinished':
          if (!userPlaySession || currentBookTime === undefined || !attributes) {
            console.log("PlaybackNearlyFinished, but userPlaySession or currentBookTime was undefined");
          } else {
            syncPlaybackProgress(userPlaySession, currentBookTime, { continueListening: true });

            const currentToken = streamToken;
            const nextTrackIndex = amazonToken + 1;
            const nextAudioTrack = userPlaySession.audioTracks.find((track) => track.index == nextTrackIndex);
            if (nextAudioTrack) {
              const nextUrl = SERVER_URL + nextAudioTrack.contentUrl + "?token=" + ABS_API_KEY;
              const nextToken = createPlaybackInstanceToken(userPlaySession, nextTrackIndex);
              const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession);
              const currentChapterID = currentChapter?.id ?? 0;

              const coverUrl = getCoverUrl(userPlaySession.libraryItemId);
              const nextChapterTitle = (userPlaySession.chapters?.[currentChapterID + 1] || {}).title
                || userPlaySession.displayTitle;
              const metadata = {
                title: nextChapterTitle,
                subtitle: userPlaySession.displayTitle,
                art: {
                  sources: [{ url: coverUrl, widthPixels: 512, heightPixels: 512 }],
                },
                backgroundImage: {
                  sources: [{ url: resolveBackgroundUrl(coverUrl), widthPixels: 1600, heightPixels: 900 }],
                },
              };
              audioResponse = handlerInput.responseBuilder
                .addAudioPlayerPlayDirective(
                  "ENQUEUE",
                  nextUrl,
                  nextToken,
                  0,
                  currentToken,
                  metadata
                )
                .getResponse();
              attributes.nextStreamEnqueued = true;
              updateLocalSessionAttributes(attributes);
            } else {
              attributes.nextStreamEnqueued = false;
              updateLocalSessionAttributes(attributes);
            }
          }
          break;

        case 'PlaybackFailed': {
          console.error('Playback failed:', JSON.stringify({
            type: handlerInput.requestEnvelope.request.error?.type
          }));
          const failedRequest = handlerInput.requestEnvelope.request;
          const currentPlaybackState = failedRequest.currentPlaybackState;
          const anotherStreamIsStillActive = currentPlaybackState?.token
            && currentPlaybackState.playerActivity !== 'IDLE'
            && !sameStreamToken(currentPlaybackState.token, failedRequest.token);
          if (anotherStreamIsStillActive && userPlaySession && currentBookTime !== undefined) {
            console.log("PlaybackFailed: queued stream failed; preserving the stream still playing");
            syncPlaybackProgress(userPlaySession, currentBookTime, { continueListening: true });
            attributes.activeStreamToken = currentPlaybackState.token;
            attributes.nextStreamEnqueued = false;
            updateLocalSessionAttributes(attributes);
          } else if (userPlaySession && currentBookTime !== undefined) {
            const knownBookTime = Number(userPlaySession.currentTime);
            const safeBookTime = Number.isFinite(knownBookTime)
              ? Math.max(currentBookTime, knownBookTime)
              : currentBookTime;
            if (safeBookTime !== currentBookTime) {
              console.log(`PlaybackFailed: ignoring a reported position of ${currentBookTime} behind the known ${safeBookTime}`);
            }
            if (closePlaybackProgress(userPlaySession, safeBookTime)) {
              clearAllMemory(handlerInput);
            } else if (attributes) {
              attributes.pendingClose = true;
              updateLocalSessionAttributes(attributes);
            }
          } else {
            console.log("PlaybackFailed: no authoritative playing position was available");
          }
          break;
        }

        default:
          break;
      }
      timestamps.AudioPlayerEventHandlerEndTime = new Date();
      console.log("TIMER: AudioPlayer event " + audioPlayerEventName + " handler time: " + (timestamps.AudioPlayerEventHandlerEndTime - audioPlayerEventStartTime) + "ms");
      if (timestamps.PlaybackControllerHandlerStartTime && audioPlayerEventName === "PlaybackStarted") {
        console.log("TIMER: time from button push to PlaybackStartedEnd: " + (timestamps.AudioPlayerEventHandlerEndTime - timestamps.PlaybackControllerHandlerStartTime) + "ms");
        timestamps.PlaybackControllerHandlerStartTime = null;
      }

      if (audioPlayerEventName === "PlaybackStarted") {
        resetTimestamps();
      }

      clearAlexaSessionAttributes(handlerInput);
      return audioResponse || handlerInput.responseBuilder.getResponse();

    } catch (error) {
      console.error("Error handling AudioPlayer event:", error);
      timestamps.AudioPlayerEventHandlerEndTime = new Date();
      console.log("TIMER: AudioPlayer event " + audioPlayerEventName + " handler time: " + (timestamps.AudioPlayerEventHandlerEndTime - audioPlayerEventStartTime) + "ms");
      if (timestamps.PlaybackControllerHandlerStartTime && audioPlayerEventName === "PlaybackStarted") {
        console.log("TIMER: time from button push to PlaybackStartedEnd: " + (timestamps.AudioPlayerEventHandlerEndTime - timestamps.PlaybackControllerHandlerStartTime) + "ms");
        timestamps.PlaybackControllerHandlerStartTime = null;
      }

      if (audioPlayerEventName === "PlaybackStarted") {
        resetTimestamps();
      }

      clearAlexaSessionAttributes(handlerInput);
      return handlerInput.responseBuilder.getResponse();
    }
  },
};

function applyBookTimeToAttributes(attributes, userPlaySession, bookTime) {
  const result = getTrackAndOffsetFromBookTime(bookTime, userPlaySession);
  if (!result.currentTrack || !Number.isFinite(result.goalOffset)) {
    throw new Error(`Could not map book time ${bookTime} to an audio track`);
  }

  const currentTrack = result.currentTrack;
  const amazonToken = currentTrack.index;
  const playback = {
    currentTrack: currentTrack,
    currentTrackIndex: amazonToken,
    amazonToken: amazonToken,
    streamToken: createPlaybackInstanceToken(userPlaySession, amazonToken),
    offsetInMilliseconds: result.goalOffset,
    playUrl: SERVER_URL + currentTrack.contentUrl + "?token=" + ABS_API_KEY,
    nextStreamEnqueued: false
  };

  Object.assign(attributes, playback);
  attributes.userPlaySession = userPlaySession;
  return playback;
}

function buildPlaybackMetadata(userPlaySession, bookTime) {
  const chapter = getCurrentChapterByBookTime(bookTime, userPlaySession);
  const coverUrl = getCoverUrl(userPlaySession.libraryItemId);
  return {
    title: chapter ? chapter.title : userPlaySession.displayTitle,
    subtitle: userPlaySession.displayTitle,
    art: {
      sources: [{ url: coverUrl, widthPixels: 512, heightPixels: 512 }]
    },
    backgroundImage: {
      sources: [{ url: resolveBackgroundUrl(coverUrl), widthPixels: 1600, heightPixels: 900 }]
    }
  };
}

function clearAllMemory(handlerInput = null) {
  try {
    const ownerKey = handlerInput ? playbackOwnerKey(handlerInput) : null;
    if (handlerInput && localSessionAttributes.playbackOwnerKey
      && localSessionAttributes.playbackOwnerKey !== ownerKey) {
      clearAlexaSessionAttributes(handlerInput);
      return;
    }
    console.log("Clearing all memory");
    localSessionAttributes = {};
    if (handlerInput?.requestEnvelope?.session?.attributes) {
      if (hasAlexaSession(handlerInput)) {
        handlerInput.attributesManager.setSessionAttributes(localSessionAttributes);
      }
    }
    clearTimers();
    resetTimestamps();
  } catch (error) {
    console.error("Error clearing all memory:", error);
  }
}

function updateLocalSessionAttributes(sessionAttributes) {
  for (let key in localSessionAttributes) {
    if (localSessionAttributes.hasOwnProperty(key)) {
      delete localSessionAttributes[key];
    }
  }

  for (let key in sessionAttributes) {
    if (sessionAttributes.hasOwnProperty(key)) {
      localSessionAttributes[key] = sessionAttributes[key];
    }
  }
  return localSessionAttributes;
}

function retainPlaybackStateLocally(handlerInput, sessionAttributes) {
  sessionAttributes.playbackOwnerKey = playbackOwnerKey(handlerInput);
  updateLocalSessionAttributes(sessionAttributes);
  clearAlexaSessionAttributes(handlerInput);
}

const PlaybackControllerHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type.startsWith('PlaybackController.');
  },
  async handle(handlerInput) {
    const playbackControllerEventName = handlerInput.requestEnvelope.request.type.split('.')[1];
    console.log(`PlaybackControllerHandler event: ${handlerInput.requestEnvelope.request.type}`);
    timestamps.PlaybackControllerHandlerStartTime = Date.now();
    const state = recoverPlaybackState(handlerInput);
    if (!state) {
      console.log('PlaybackControllerHandler: no active play session');
      clearAlexaSessionAttributes(handlerInput);
      return handlerInput.responseBuilder.getResponse();
    }

    const { attributes, userPlaySession, offsetInMilliseconds,
      trackIndex: amazonToken, rawToken } = state;
    const chapters = userPlaySession.chapters;

    const currentBookTime = calculateCurrentTime(userPlaySession, offsetInMilliseconds, amazonToken);

    let response;
    switch (playbackControllerEventName) {
      case 'PlayCommandIssued': {
        const playback = applyBookTimeToAttributes(attributes, userPlaySession, currentBookTime);
        preparePlaybackTransition(attributes, playback, rawToken, false);
        updateLocalSessionAttributes(attributes);
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            'REPLACE_ALL',
            playback.playUrl,
            playback.streamToken,
            playback.offsetInMilliseconds,
            null,
            buildPlaybackMetadata(userPlaySession, currentBookTime)
          )
          .getResponse();
        break;
      }
      case 'PauseCommandIssued': {
        const currentPositionSynced = syncPlaybackProgress(userPlaySession, currentBookTime);
        attributes.supersededStreamToken = rawToken;
        attributes.supersededStreamPositionSynced = currentPositionSynced;
        updateLocalSessionAttributes(attributes);

        response = handlerInput.responseBuilder
          .addAudioPlayerStopDirective()
          .getResponse();
        break;
      }
      case 'PreviousCommandIssued': {
        const currentPositionSynced = syncPlaybackProgress(
          userPlaySession, currentBookTime, { continueListening: true });
        const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession);
        const chapterIndex = chapters.indexOf(currentChapter);
        const previousChapter = chapterIndex > 0 ? chapters[chapterIndex - 1] : null;
        const targetChapter = currentBookTime > currentChapter.start + 5
          ? currentChapter
          : (previousChapter || chapters[0]);
        const newBookTime = targetChapter.start;
        const playback = applyBookTimeToAttributes(attributes, userPlaySession, newBookTime);
        preparePlaybackTransition(attributes, playback, rawToken, currentPositionSynced);
        updateLocalSessionAttributes(attributes);
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            'REPLACE_ALL',
            playback.playUrl,
            playback.streamToken,
            playback.offsetInMilliseconds,
            null,
            buildPlaybackMetadata(userPlaySession, newBookTime)
          )
          .getResponse();
        break;
      }
      case 'NextCommandIssued': {
        const currentPositionSynced = syncPlaybackProgress(
          userPlaySession, currentBookTime, { continueListening: true });
        const currentChapter = getCurrentChapterByBookTime(currentBookTime, userPlaySession);
        const chapterIndex = chapters.indexOf(currentChapter);
        const nextChapter = chapters[chapterIndex + 1];
        if (!nextChapter) {
          console.log('NextCommandIssued: already in the final chapter');
          clearAlexaSessionAttributes(handlerInput);
          return handlerInput.responseBuilder.getResponse();
        }
        const newBookTime = nextChapter.start;
        const playback = applyBookTimeToAttributes(attributes, userPlaySession, newBookTime);
        preparePlaybackTransition(attributes, playback, rawToken, currentPositionSynced);
        updateLocalSessionAttributes(attributes);
        response = handlerInput.responseBuilder
          .addAudioPlayerPlayDirective(
            'REPLACE_ALL',
            playback.playUrl,
            playback.streamToken,
            playback.offsetInMilliseconds,
            null,
            buildPlaybackMetadata(userPlaySession, newBookTime)
          )
          .getResponse();
        break;
      }
      default:
        response = handlerInput.responseBuilder.getResponse();
        break;
    }

    timestamps.PlaybackControllerHandlerEndTime = Date.now();
    console.log(`TIMER: Time to handle ${playbackControllerEventName} intent: ${timestamps.PlaybackControllerHandlerEndTime - timestamps.PlaybackControllerHandlerStartTime} ms`);
    clearAlexaSessionAttributes(handlerInput);
    return response;
  },
};

const SystemExceptionHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'System.ExceptionEncountered';
  },
  handle(handlerInput) {
    const request = handlerInput.requestEnvelope.request;
    console.error('System exception encountered:', JSON.stringify({
      type: request.error?.type,
      requestId: request.cause?.requestId
    }));
    const state = recoverPlaybackState(handlerInput, { allowSessionReplacement: false });
    if (state) {
      state.attributes.nextStreamEnqueued = false;
      updateLocalSessionAttributes(state.attributes);
    }
    return handlerInput.responseBuilder.getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    const speakOutput = 'Sorry, I don\'t know about that. Please try again.';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    try {
      const request = handlerInput.requestEnvelope.request;
      const playerActivity = handlerInput.requestEnvelope.context?.AudioPlayer?.playerActivity;
      console.log('SessionEndedRequest:', JSON.stringify({
        reason: request.reason,
        errorType: request.error?.type,
        playerActivity
      }));

      if (['PLAYING', 'PAUSED', 'BUFFER_UNDERRUN'].includes(playerActivity)) {
        console.log(`SessionEndedRequest: preserving ${playerActivity.toLowerCase()} playback state`);
        return handlerInput.responseBuilder.getResponse();
      }

      const state = recoverPlaybackState(handlerInput, { allowSessionReplacement: false });
      if (state && state.offsetInMilliseconds !== null) {
        const currentBookTime = calculateCurrentTime(
          state.userPlaySession, state.offsetInMilliseconds, state.trackIndex);
        if (closePlaybackProgress(state.userPlaySession, currentBookTime)) {
          console.log("SessionEndedRequest: successfully synced and closed ABS session");
          clearAllMemory(handlerInput);
        } else {
          state.attributes.pendingClose = true;
          updateLocalSessionAttributes(state.attributes);
          clearAlexaSessionAttributes(handlerInput);
        }
      } else {
        console.log("SessionEndedRequest: no recoverable playback state");
        clearAllMemory(handlerInput);
      }

      return handlerInput.responseBuilder.getResponse();
    } catch (error) {
      console.error('Error during SessionEndedRequestHandler:', error);
      throw error;
    }
  }
};

const IntentReflectorHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
  },
  handle(handlerInput) {
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    console.log(`Unhandled intent reached IntentReflectorHandler: ${intentName}`);
    const speakOutput = "Sorry, I can't do that yet.";

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error('~~~~ Error handled:', (error && (error.stack || error.message)) || error);

    const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (!['IntentRequest', 'LaunchRequest'].includes(requestType)) {
      return handlerInput.responseBuilder.getResponse();
    }

    const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.';
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    RecentBooksIntentHandler,
    PlayAudioIntentHandler,
    PlayBookIntentHandler,
    PauseAudioIntentHandler,
    PreviousIntentHandler,
    NextIntentHandler,
    GoToChapterXIntentHandler,
    GoForwardXTimeIntentHandler,
    GoBackXTimeIntentHandler,
    UnsupportedAudioIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    AudioPlayerEventHandler,
    PlaybackControllerHandler,
    SystemExceptionHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
    IntentReflectorHandler)
  .addErrorHandlers(
    ErrorHandler)
  .withCustomUserAgent('AlexaSkill')
  .lambda();
