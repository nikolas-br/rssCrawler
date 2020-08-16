const puppeteer = require("puppeteer");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");
let Parser = require("rss-parser");
const fs = require("fs");

const parser = new Parser({ timeout: 2000 });

// const various = [
//   "economist",
//   "the verge",
//   "spiegel",
//   "engadget",
//   "hackernews",
//   "cicero",
//   "foreign affairs",
//   "quilette",
//   "achgut",
//   "tichys einblick",
//   "novo",
//   "archdaily",
//   "politico",
//   "the new yorker",
//   "project syndicate",
// ];

const getPaperSelection = async () => {
  const germanPapers =
    "https://de.wikipedia.org/wiki/Liste_deutscher_Zeitungen";

  const paperSelection = await fetch(germanPapers)
    .then((result) => result.text())
    .then((data) => {
      const { document } = new JSDOM(data).window;

      // Get paper name and circulation from table
      let papers = Array.from(
        document.querySelector("#tageszeitungen > tbody").children
      )
        .map((e) => e.children)
        .map((e) => ({
          name: e[1].textContent,
          circulation: e[6].textContent,
        }));

      // Convert circulation string to number
      papers = papers.map((e) => ({
        name: e.name,
        circulation: parseInt(e.circulation.replace(".", "")),
      }));

      // Filter out low circulation papers
      papers = papers.filter((e) => e.circulation > 50000);
      // Sort list by circulation in descending order
      papers.sort((a, b) => b.circulation - a.circulation);

      return papers;
    })
    .catch((err) => {
      throw new Error(err);
    });

  return paperSelection.map((e) => e.name);
};

const getPossibleRSSLinks = async (paperName, page) => {
  const searchEngine = "https://www.google.de/search?q=";
  let results = [];

  // Construct the URL for the search query, i.e. "https://www.google.de/search?q=paperName rss"
  const searchEngineQuery = searchEngine + paperName + " rss";

  await page.goto(searchEngineQuery).catch((err) => {
    throw new Error(err);
  });

  // Google's search matches are grouped in elements of the class r
  const searchMatches = await page.evaluate(() => {
    const hits = Array.from(document.querySelectorAll(".r"));

    return hits.map((e) => e.firstElementChild.href);
  });

  // Visit first few seach matches to look for rss links
  for (let i = 0; i < 4; i++) {
    let check = true;
    await page
      .goto(searchMatches[i], { waitUntil: "domcontentloaded", timeout: 10000 })
      .catch((err) => {
        check = false;
        console.error(err);
      });

    if (!check) continue;

    const possibleRSS = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .filter((e) => /feed|rss/.test(e.href))
        .map((e) => e.href);
    });

    results.push(...possibleRSS);
  }

  return results;
};

const validateRSSLinks = async (links) => {
  let promiseArray = [];
  let validatedLinks = [];

  for (let link of links) {
    const promise = new Promise((resolve, _) => {
      parser.parseURL(link, (err, obj) => {
        if (err) {
          resolve(null);
          return;
        }

        // Only include feeds with more than 10 entries
        if (obj.items.length < 10) {
          resolve(null);
          return;
        }

        // Only include feed if it has title or description
        if (
          typeof obj.title === "undefined" ||
          typeof obj.description === "undefined"
        ) {
          resolve(null);
          return;
        }

        // Only include feed that appears to have a meaningful title and description
        if (obj.title.length < 5 && obj.description.length < 5) {
          resolve(null);
          return;
        }

        // Only include recent feeds
        const date = new Date(obj.items[0].pubDate);
        const lastMonth = new Date("2020-08-01");
        if (date < lastMonth) {
          resolve(null);
          return;
        }

        let image = null;
        if (typeof obj.image !== "undefined") image = obj.image.url;

        const feedObj = {
          title: obj.title,
          description: obj.description,
          image,
          feedURL: link,
          link: obj.link,
        };

        validatedLinks.push(feedObj);
        resolve(null);
      });
    });
    promiseArray.push(promise);
  }

  await Promise.all(promiseArray);

  return validatedLinks;
};

(async () => {
  let RSSlist = [];
  const setRSSlist = new Set();

  const paperSelection = await getPaperSelection().catch((err) => {
    throw new Error(err);
  });
  console.log(paperSelection);

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  let progressCounter = 1;

  // Get rss links for every paper
  for (let paper of paperSelection) {
    console.log(`\nProgress: ${progressCounter++} of ${paperSelection.length}`);

    // Get possible rss links from google search
    const possibleRSS = await getPossibleRSSLinks(paper, page).catch((err) => {
      throw new Error(err);
    });
    console.log(`${possibleRSS.length} possible rss links found for ${paper}`);

    // Validate possible links by checking if they are rss and meet certain criteria
    const validatedRSS = await validateRSSLinks(possibleRSS);
    console.log("Number of validated links:", validatedRSS.length);

    // Prevent duplicate entries in our dataset
    validatedRSS.forEach((e) => {
      if (setRSSlist.has(e.feedURL)) return;

      RSSlist.push(e);
      setRSSlist.add(e.feedURL);
    });
  }

  // We now have our checked and consolidated list of feeds, which we can write to a file
  const data = JSON.stringify(RSSlist, null, 2);
  fs.writeFile("rsslist.json", data, (err) => {
    if (err) throw new Error(err);
  });
  console.log("\nTotal number of rss feeds found:", RSSlist.length);

  // Terminate the page and browser instances
  await page.close();
  await browser.close();
})().catch((err) => console.error(err));

// feedUrl: 'https://www.reddit.com/.rss'
// title: 'reddit: the front page of the internet'
// description: ""
// link: 'https://www.reddit.com/'
// items:
//     - title: 'The water is too deep, so he improvises'
//       link: 'https://www.reddit.com/r/funny/comments/3skxqc/the_water_is_too_deep_so_he_improvises/'
//       pubDate: 'Thu, 12 Nov 2015 21:16:39 +0000'
//       creator: "John Doe"
//       content: '<a href="http://example.com">this is a link</a> &amp; <b>this is bold text</b>'
//       contentSnippet: 'this is a link & this is bold text'
//       guid: 'https://www.reddit.com/r/funny/comments/3skxqc/the_water_is_too_deep_so_he_improvises/'
//       categories:
//           - funny
//       isoDate: '2015-11-12T21:16:39.000Z'
