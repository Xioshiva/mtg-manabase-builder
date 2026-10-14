# Manabase Builder

Paste a Magic: The Gathering decklist and the builder does five things:

1. **Recommends a land count** with Frank Karsten's formula, which uses average mana value, cheap card draw and spell/land double-faced cards.
2. **Estimates the colored sources you need** in each color so every spell is castable on curve 90% of the time.
3. **Simulates thousands of goldfish games** to test the manabase. The simulation handles London mulligans, land drops and lands that enter tapped. It also casts card draw and selection spells (Opt, Consider, Stock Up, creatures that draw when they enter, loot effects) to dig for lands.
4. **Searches for a better manabase**. It swaps basics and Standard-legal dual lands one at a time and keeps each swap that does better in simulation.
5. **Compares land counts** from two fewer to two more lands, looking at land drops, flood and mana spent.

Standard is the main target. Pioneer, Modern and Commander are included as previews (see `public/lib/formats.js`).

## Run it

You need Node 18 or newer. There are no dependencies to install.

```
node server.js          # then open http://localhost:5173
```

Your browser fetches card data from Scryfall and caches it locally.

To load a deck, paste the list (Arena or MTGO export) or paste a link to a public Moxfield deck and click Import. Moxfield doesn't let web pages fetch decks directly, so the local server fetches the deck for the page. That's why you open the app through `node server.js` instead of opening the HTML file. If Moxfield refuses the request, use Export → Copy for MTGA in Moxfield and paste the list instead.

Command line version:

```
node cli.js mydeck.txt                      # check and improve my lands
node cli.js mydeck.txt --mode build         # ignore my lands, build from scratch
node cli.js mydeck.txt --games 50000 --play draw --lands 23
node cli.js https://moxfield.com/decks/<id>   # import from Moxfield
node cli.js test/fixtures/izzet.txt --cards test/fixtures/cards.json   # offline sample
```

Tests: `npm test`

## What the numbers mean

- **Castable on curve**: how often your untapped lands can pay for a spell you hold on the turn equal to its mana value. The headline number averages this over every spell, weighted by copies.
- **Colors OK when you had the lands**: the same measure, but only for games where you had enough lands. A low number points to a color or tapped-land problem rather than a land count problem.
- **Mana spent by turn 7**: the total mana the bot actually used. Missed land drops, tapped lands and flood all lower it.
- **Flooded**: games where you drew at least four more lands than the deck needs by turn 7.
- **Life paid**: life spent on shocklands played untapped and on painlands tapped for mana.

## How accurate it is

The builder uses two methods together:

- **Exact probability math** (the hypergeometric distribution, as in Karsten's articles) gives the instant baseline for land count and colored sources. It's exact but can't model mulligans, tapped lands or draw spells.
- **Monte Carlo simulation** plays the deck out game by game, so it handles everything the bot knows how to do. Its error shrinks with more games: every number is shown with a 95% margin of error (±). At 10,000 games the headline numbers are good to within about ±0.4 points and single spells to about ±1 to 1.5 points. Use 50,000 when two manabases are close. Because spells in the same game share the same lands, the headline margins are measured from the spread across 20 batches of games instead of assuming each spell is independent.

The two manabases you compare play the same shuffled games, so the difference between them is more precise than either ± alone. The search screens swaps on one set of games and confirms them on another, and it only accepts a swap that wins by more than the noise.

## How the simulator plays

Each turn the bot follows these steps:

1. Draw a card.
2. If there's no land in hand, cast cheap draw spells first to look for one.
3. Play the land that lets it cast the most this turn. It prefers a tapped land when that costs nothing, and pays life for a shockland only when that matters.
4. Cast the most expensive spells it can afford, then spend leftover mana on draw spells.

Scry, surveil and "look at the top N" effects keep lands while the bot is short on lands, and keep spells otherwise.

The simulator understands these lands: basics, fast lands, slow lands, check lands, shocklands, pay-life double-faced lands, surveil lands, verges, pathways, thriving lands, painlands, fetches like Fabled Passage, and plain tapped lands. A land with an "enters tapped unless" condition it doesn't recognize is treated as always tapped and listed in the notes.

## Known limits

- Mana creatures and mana rocks don't count as mana sources yet. The notes flag them.
- Draw effects are read from rules text. Check the "Draw and selection spells" table to see what was detected.
- Modal spells with a draw mode always use that mode.
- Commander support is a preview. It doesn't handle commander tax or check color identity yet.

## Layout

```
public/lib/decklist.js   parse pasted lists
public/lib/scryfall.js   Scryfall API (collection lookup, legal land search)
public/lib/moxfield.js   Moxfield deck import (fetched through server.js)
public/lib/cards.js      Scryfall card -> land / spell model
public/lib/mana.js       mana costs and payment
public/lib/sim.js        the game simulator
public/lib/recommend.js  land count formula, sources needed, basic split
public/lib/optimize.js   manabase search, land count sweep
public/lib/analysis.js   puts it all together
public/lib/formats.js    format rules (add new formats here)
public/app.js, worker.js the web page (simulation runs in a Web Worker)
cli.js, server.js        command line tool and static server
```
