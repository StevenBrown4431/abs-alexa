'use strict';

const Fuse = require('fuse.js');
const request = require('sync-request');
const { getAllLibraries, getAllAudiobooks, searchFor } = require('./abs-client');
const { timers } = require('./timers');

function getEntityData(entityUrl, accessToken, locale) {
  try {
    const res = request('GET', entityUrl, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept-Language': locale,
        'Accept': 'application/ld+json'
      }
    });

    if (res.statusCode === 200) {
      return JSON.parse(res.getBody('utf8'));
    }
    return null;
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    return null;
  }
}

function fuzzyMatch({
  searchData, searchKey, key, threshold = 0.6, arrayOrBest = 'best', scoreThreshold = 1
}) {
  const options = { keys: [key], includeScore: true, threshold };
  const fuse = new Fuse(searchData, options);
  const results = fuse.search(searchKey);
  const bestResult = results[0];

  if (bestResult && bestResult.score < scoreThreshold) {
    return arrayOrBest === "best" ? bestResult.item : (results || null);
  }
  return null;
}

function fuzzyStringMatch(string1, string2, includeScore = true, threshold = 0.6) {
  const scoreThreshold = 0.6;
  if (!string1 || !string2) return null;
  const fuse = new Fuse([string1], { includeScore, threshold });
  const result = fuse.search(string2)[0];
  if (!result || result.score >= scoreThreshold) return null;
  return { item: result.item, score: result.score };
}

function searchBookWithAbsAPI(bookTitle) {
  const allLibraries = getAllLibraries();
  const supportedLibraries = allLibraries.filter(
    library => (library.mediaType === 'book' && library.settings?.audiobooksOnly) || library.mediaType === 'podcast'
  );
  const libraryIDs = supportedLibraries.map(library => library.id);

  let results = [];
  libraryIDs.forEach(function (libraryID, i) {
    results[i] = searchFor(bookTitle, libraryID);
  });

  return results;
}

function firstBookFromAbsSearch(searchResults) {
  for (const result of searchResults) {
    if (!result) continue;
    if (Array.isArray(result.book) && result.book.length > 0) return result.book[0];
    if (Array.isArray(result.podcast) && result.podcast.length > 0) return result.podcast[0];
  }
  return null;
}

function amazonCrossmatch(titleResolutions, authorResolutions, accessToken) {
  let checkedTitles = [];
  let validAuthors = [];
  let validTitles = [];
  let callFailed = false;

  for (let j = 0; j < titleResolutions.values.length; j++) {
    let resolutionTitle = titleResolutions.values[j].value.name;
    if (checkedTitles.includes(resolutionTitle)) continue;

    const apiUrl = titleResolutions.values[j].value.id;
    const titleData = getEntityData(apiUrl, accessToken, "en-US") || null;
    if (!titleData) callFailed = true;

    const authors = titleData ? (titleData["entertainment:author"] || null) : null;
    if (authors) {
      for (let i = 0; i < authorResolutions.values.length; i++) {
        const authorName = authorResolutions.values[i].value.name;
        for (let x = 0; x < authors.length; x++) {
          if (authors[x].name[0]["@value"] === authorName || fuzzyStringMatch(authors[x].name[0]["@value"], authorName)) {
            validTitles.push(resolutionTitle);
            validAuthors.push(authorName);
          }
        }
      }
    }
    if (!callFailed) checkedTitles.push(resolutionTitle);
    callFailed = false;
  }
  return { validAuthors, validTitles };
}

function searchByTitleOnly({ bookTitle, APIsearch = true, fuzzySearch = true }) {
  const start = new Date();
  if (APIsearch) {
    console.log("Performing ABS API search for '" + bookTitle + "'");
    const absSearchResults = searchBookWithAbsAPI(bookTitle);
    const firstMatchingItem = firstBookFromAbsSearch(absSearchResults);
    if (firstMatchingItem) {
      console.log("Matched an item using ABS search API!");
      return firstMatchingItem.libraryItem;
    }
    timers.ABSapi = new Date() - start;
  }
  if (fuzzySearch) {
    const startFuzzy = new Date();
    console.log("Fuzzy matching all ABS books & podcasts for '" + bookTitle + "'");
    const allItems = getAllAudiobooks();
    timers.context.absDatabaseSize = allItems.length;
    const matchResults = fuzzyMatch({
      searchData: allItems,
      searchKey: bookTitle,
      key: 'media.metadata.title',
      threshold: 0.6,
      arrayOrBest: 'array',
      scoreThreshold: 0.6
    });
    const matchResult = matchResults?.[0] || null;
    timers.fuzzySearch = new Date() - startFuzzy;
    if (matchResult) {
      console.log("Matched an item in ABS library using fuzzy matching!");
      return matchResult.item;
    }
  }
  return null;
}

module.exports = {
  getEntityData, fuzzyMatch, fuzzyStringMatch, searchBookWithAbsAPI,
  firstBookFromAbsSearch, amazonCrossmatch, searchByTitleOnly
};
