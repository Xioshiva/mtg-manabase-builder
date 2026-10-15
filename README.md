# Manabase Builder

Paste a Magic: The Gathering decklist, or a Moxfield or MTGTop8 deck link, and the builder does five things:

1. **Recommends a land count** with Frank Karsten's formula, which uses average mana value, cheap card draw and spell/land double-faced cards.
2. **Estimates the colored sources you need** in each color so every spell is castable on curve 90% of the time.
3. **Simulates thousands of goldfish games** to test the manabase. The simulation handles London mulligans, land drops and lands that enter tapped. It casts card draw and selection spells (Opt, Consider, Stock Up, creatures that draw when they enter, loot effects) to dig for lands, and uses mana creatures and mana rocks once they are on the battlefield.
4. **Searches for a better manabase**. It swaps basics and dual lands legal in your format one at a time and keeps each swap that does better in simulation. Lands that do more than make mana (creature lands, lands that draw or make tokens, graveyard hate) stay as they are, because the simulator can't judge what they're worth. Untick "Keep lands that do more than make mana" (or pass `--swap-utility`) to let the search replace them too. Lands you lock in the deck editor are never swapped.
5. **Compares land counts** from two fewer to two more lands, looking at land drops, flood and mana spent.

Standard, Pioneer and Modern are supported. Commander is included as a preview (see `public/lib/formats.js`).

## Run it

You need Node 18 or newer. There are no dependencies to install.

```
node server.js          # then open http://localhost:5173
```

Your browser fetches card data from Scryfall and caches it locally.

To load a deck, paste the list (Arena or MTGO export) in the Text tab, or paste a link to a public Moxfield deck or an MTGTop8 deck and click Import. Neither site lets web pages fetch decks directly, so the local server fetches the deck for the page. That's why you open the app through `node server.js` instead of opening the HTML file. If a site refuses the request, export the list from it and paste it instead.

### Editing and saving a deck

Once a deck is loaded, the Cards tab shows every card with its picture, grouped by type:

- **+ and −** change the number of copies. The text list stays in step, so you can switch between Cards and Text at any time.
- **Add a card by name** with the box above the cards. Names autocomplete from Scryfall.
- **🔓 on a land** locks it. The search never swaps a locked land, in either mode. Click 🔒 to unlock it. When you set a land count, the unlocked lands grow or shrink to meet it; if every land is locked, the results say the count couldn't change.
- **Dual lands legal in the format** for your colors are listed under your lands, best first, with + to add one. The list comes from Scryfall's legality data for the format you pick, so it changes when you switch formats. When a color is short of sources, the results also name the duals that would help.
- **Use these lands in my list**, under the suggested manabase, swaps your lands for the suggested ones. It asks first if you changed the deck after the analysis.
- **Sideboard, Companion and Maybeboard** sections from your list are shown under the main deck and kept when the list is rewritten. Only the main deck (and commander) is simulated.
- **Save** keeps the deck, its format and its locked lands in this browser under the name you give it. Open it again from the Saved decks menu. **Download .txt** saves the list as a file.

Command line version:

```
node cli.js mydeck.txt                      # check and improve my lands
node cli.js mydeck.txt --mode build         # ignore my lands, build from scratch
node cli.js mydeck.txt --games 50000 --play draw --lands 23
node cli.js mydeck.txt --threads 2          # use 2 CPU threads (default: all)
node cli.js https://moxfield.com/decks/<id>   # import from Moxfield
node cli.js "https://www.mtgtop8.com/event?e=<event>&d=<deck>&f=ST"   # import from MTGTop8
node cli.js test/fixtures/izzet.txt --cards test/fixtures/cards.json   # offline sample
```

Tests: `npm test`

## Tested on real decks

`test/fixtures/real/` holds 31 decks that placed at events listed on MTGTop8 in October 2026 (13 Standard, 9 Pioneer, 9 Modern), with the rules text of every card in them (see its README for the sources). The tests check that every deck loads, is legal in its format, simulates, and has no land the builder can't read. Two scripts help when the builder misreads something:

```
node scripts/real-decks.js                     # analyze all 31 decks (add --optimize to search for better lands)
node scripts/real-decks.js --format modern     # just the Modern decks (standard, pioneer or modern)
node scripts/real-decks.js --deck dimir        # just the decks whose file name contains "dimir"
node scripts/explain-cards.js                  # each card's rules text next to what the builder understood
```

## What the numbers mean

- **Castable on curve**: how often your mana can pay for a spell you hold on its curve turn. The curve turn is the spell's mana value, plus any extra cost it asks for (such as "behold a Merfolk or pay {2}"). The headline number averages this over every spell, weighted by copies. Spells that get cheaper as the game goes on (Eddymurk Crab, for example) are shown but left out of the headline, because their curve turn depends on the game.
- **Colors OK when you had the lands**: the same measure, but only for games where you had enough lands. A low number points to a color or tapped-land problem rather than a land count problem.
- **Mana spent by turn 7**: the total mana the bot actually used. Missed land drops, tapped lands and flood all lower it.
- **Flooded**: games where you drew at least four more lands than the deck needs by turn 7.
- **Life paid**: life spent on shocklands played untapped, fetching, and lands that cost life for colored mana (painlands, Starting Town).

## How accurate it is

The builder uses two methods together:

- **Exact probability math** (the hypergeometric distribution, as in Karsten's articles) gives the instant baseline for land count and colored sources. It's exact but can't model mulligans, tapped lands or draw spells.
- **Monte Carlo simulation** plays the deck out game by game, so it handles everything the bot knows how to do. Its error shrinks with more games: every number is shown with a 95% margin of error (±). At 10,000 games the headline numbers are good to within about ±0.4 points and single spells to about ±1 to 1.5 points. Use 50,000 when two manabases are close. Because spells in the same game share the same lands, the headline margins are measured from the spread across 20 batches of games instead of assuming each spell is independent.

The two manabases you compare play the same shuffled games, so the difference between them is more precise than either ± alone. The search screens swaps on one set of games and confirms them on another, and it only accepts a swap that wins by more than the noise.

Simulations run on every CPU thread your computer has (up to 16 in the browser, 64 on the command line). Each batch of games has its own fixed shuffle seed, and the search stops after a set number of steps rather than after a set time, so the numbers and the suggested lands are exactly the same whether they run on one thread or sixteen; only the speed changes.

## How the simulator plays

Each turn the bot follows these steps:

1. Draw a card.
2. If there's no land in hand, cast cheap draw spells first to look for one.
3. Play the land that lets it cast the most this turn. It prefers a tapped land when that costs nothing, and pays life for a shockland only when that matters.
4. Cast the most expensive spells it can afford, then spend leftover mana on draw spells. Mana creatures and mana rocks are cast early when they help; rocks can tap for mana right away and creatures from the next turn. Treasure tokens (from cards that make them on entering, each upkeep, or from Saga chapters) are spent only when nothing else can pay. Permanents that grant an extra land drop let the bot play another land.

Scry, surveil and "look at the top N" effects keep lands while the bot is short on lands, and keep spells otherwise.

The simulator understands these lands: basics (snow basics and Wastes too), fast lands, slow lands, check lands, shocklands, pay-life double-faced lands, surveil lands, scry lands (Temples), verges, pathways, thriving lands, painlands, lands that pick a basic land type (Multiversal Passage), lands that are untapped on your first three turns (Starting Town), lands whose colored mana can only cast creatures or only instants and sorceries (Cavern of Souls style), lands that enter untapped if you behold a card type (Theorist's Sanctum), and plain tapped lands. A land with an "enters tapped unless" condition it doesn't recognize is treated as always tapped and listed in the notes.

For Pioneer and Modern it also understands:

- **Fetchlands** (Polluted Delta, Prismatic Vista, Evolving Wilds, Fabled Passage). The bot fetches the land it needs most, pays the life, and only counts a fetch as a source of a color when the deck has a land of that color it can find.
- **Lands that make more than one mana**: bounce lands like Simic Growth Chamber (they return a land to your hand), Lotus Field (it sacrifices two lands, so the bot waits until it has two others), and Urza's Saga (it makes mana until its last chapter, is tapped once more and then leaves). A land that is about to be returned or sacrificed is tapped for mana first.
- **Lands and permanents that change other lands**: Urborg, Tomb of Yawgmoth and Leyline of the Guildpact give your lands more colors, and Spelunking makes lands enter untapped.
- **Leylines**: every Leyline in your opening hand starts the game on the battlefield.
- **Ramp**: spells and creatures that put lands onto the battlefield (Rampant Growth, Cultivate, Primeval Titan) or let you put a land from your hand (Arboreal Grazer), plus mana rocks that make two mana (Sol Ring), Mox Opal (it only works with three artifacts, artifact lands included), land tokens (Overlord of the Hauntwoods) and mana a permanent adds as it enters (Outcaster Trailblazer, Crumbling Vestige).
- **Domain**: spells that cost less for each basic land type you control (Leyline Binding, Scion of Draco).
- **The legend rule**: the bot never casts a second copy of a legendary permanent it already has.

## Known limits

- Mana creatures and rocks that need more than a tap to make mana (sacrificing, discarding, tapping other creatures) aren't used as mana. The notes flag them.
- Card data from Scryfall must be reachable from your browser. Decks from MTGTop8 use the same names as Scryfall, including double-faced cards written as "Front/Back".
- Draw effects are read from rules text. Check the "Draw and selection spells" table to see what was detected. Draws that depend on the opponent, on sacrificing something, or on which colors paid for the spell aren't counted; the notes list them.
- The search only values mana. It can't tell how good a creature land or a utility land is, which is why it keeps them by default.
- Modal spells with a draw mode always use that mode.
- Mana that depends on the board isn't counted: devotion (Nykthos), the Tron bonus (each Urza's land makes one {C}), Ugin's Labyrinth's exiled card, cascade, and life paid for Phyrexian mana.
- Amulet of Vigor's untap isn't modelled: lands that enter tapped stay tapped.
- Mana from abilities that cost life or only cast some spells is counted once, even when the ability makes more than one mana.
- Spells with no mana cost (suspend cards like Ancestral Vision, Living End) are never cast.
- Alternative costs (evoke, impending, warp, dash, delve) aren't used: a spell is always cast for its mana cost.
- Effects that sacrifice any number of lands (Scapeshift) or return lands from the graveyard (Lumra) aren't modelled.
- Commander support is a preview. It doesn't handle commander tax or check color identity yet.

## Layout

```
public/lib/decklist.js   parse, edit and write decklists
public/lib/deckstore.js  saved decks (browser storage)
public/lib/lands.js      the legal lands worth offering for a deck's colors
public/lib/scryfall.js   Scryfall API (collection lookup, legal land search)
public/lib/moxfield.js   Moxfield deck import (fetched through server.js)
public/lib/mtgtop8.js    MTGTop8 deck import (fetched through server.js)
public/lib/importers.js  picks the importer for a deck link
public/lib/cards.js      Scryfall card -> land / spell model
public/lib/mana.js       mana costs and payment
public/lib/sim.js        the game simulator
public/lib/pool.js       spreads simulations across threads
public/lib/recommend.js  land count formula, sources needed, basic split
public/lib/optimize.js   manabase search, land count sweep
public/lib/analysis.js   puts it all together
public/lib/formats.js    format rules (add new formats here)
public/app.js            the web page
public/editor.js         the card view of the deck (+/−, locks, dual lands)
public/sim-worker.js     one simulation thread for the web page
cli.js, server.js        command line tool and static server
node-pool.js             simulation threads for the command line
static-file.js           maps page addresses to files for server.js
scripts/                 real-deck report and card reading checker
```
