# Real decklists

Top-8 decklists from MTGTop8, fetched from the MTGO export of each deck: Standard in `decks/` ([format page](https://www.mtgtop8.com/format?f=ST), fetched 2026-10-14), Pioneer in `pioneer/` and Modern in `modern/` ([Pioneer](https://www.mtgtop8.com/format?f=PI), [Modern](https://www.mtgtop8.com/format?f=MO), fetched 2026-10-15). Duel Commander decks are in `duel/` ([format page](https://www.mtgtop8.com/format?f=EDH), fetched 2026-10-17); MTGTop8's export lists the commander as the only sideboard card. Multiplayer Commander decks are in `commander/`: five cEDH decks from MTGTop8 ([format page](https://www.mtgtop8.com/format?f=cEDH), fetched 2026-10-18) and four casual decks (see the table for their sources). Their files list the commander under a `Commander` line after the main deck. Card text in `cards.json` was copied from [mtg.wtf](https://mtg.wtf), [Archidekt](https://archidekt.com) or the magicthegathering.io API for 1232 of the 1353 cards, and from other card sites for the rest, most of them from [Forge](https://github.com/Card-Forge/forge)'s card files and grimoria.app (each card's `source` field names the site). Scryfall is blocked from the environment these fixtures were built in. The cards are stored in the same shape as Scryfall card objects, with `legalities` for the formats each card was fetched for, plus Duel Commander and Commander for every card. Duel Commander legality comes from the committee's [banned list](https://www.duelcommander.org/banlist/) (last updated July 27, 2026), and Commander legality from Wizards' [banned list](https://magic.wizards.com/en/banned-restricted-list) as set by the [February 9, 2026 announcement](https://magic.wizards.com/en/news/announcements/commander-banned-and-restricted-february-9-2026), checked on 2026-10-18. That list includes the Conspiracy cards, the ante cards and the cards banned for offensive content. A card is `banned` if it is on the list and `legal` otherwise. Cards banned only as a commander (Duel Commander) or only as a companion (Lutri, the Spellchaser, in Commander) are not marked. `color_identity` is the card site's when it covers every mana symbol in the card's text, and is worked out from the text (reminder text left out), color indicators and basic land types otherwise. Snow-covered basics and Wastes were added by hand. Deserted Beach is marked legal in Standard because two of the Standard decks, one from MTGO, play it; the card site listed it as not legal.

## Standard

| File | Archetype | Event | Deck |
|---|---|---|---|
| decks/dimir-control-899834.txt | Dimir Control | MTGO Challenge 16 (Standard, 11/10/26, 43 players) - 1st, _IlNano_ | [link](https://www.mtgtop8.com/event?e=92141&d=899834&f=ST) |
| decks/dimir-aggro-899839.txt | Dimir Aggro | MTGO Challenge 16 (Standard, 11/10/26, 43 players) - 2nd, ch4rm2nd0r | [link](https://www.mtgtop8.com/event?e=92141&d=899839&f=ST) |
| decks/mono-green-landfall-899843.txt | Mono Green Landfall | MTGO Challenge 16 (Standard, 11/10/26, 43 players) - 5-8, jtl005 | [link](https://www.mtgtop8.com/event?e=92141&d=899843&f=ST) |
| decks/orzhov-aggro-899840.txt | Orzhov Aggro | MTGO Challenge 16 (Standard, 11/10/26, 43 players) - 5-8, Solodin | [link](https://www.mtgtop8.com/event?e=92141&d=899840&f=ST) |
| decks/uw-control-899836.txt | UW Control | MTGO Challenge 16 (Standard, 11/10/26) - _rednax_ | [link](https://www.mtgtop8.com/event?e=92141&d=899836&f=ST) |
| decks/uw-control-899181.txt | UW Control | Saturday ReCQ 3:00pm @ SCG CON Los Angeles (Standard, 11/10/26) - Roman Fusco | [link](https://www.mtgtop8.com/event?e=92058&d=899181&f=ST) |
| decks/boros-aggro-899182.txt | Boros Aggro | Saturday ReCQ 3:00pm @ SCG CON Los Angeles (Standard, 11/10/26) - Gene Frazier, #2 | [link](https://www.mtgtop8.com/event?e=92058&d=899182&f=ST) |
| decks/rakdos-aggro-899184.txt | Rakdos Aggro | Saturday ReCQ 3:00pm @ SCG CON Los Angeles (Standard, 11/10/26) - Tehpope | [link](https://www.mtgtop8.com/event?e=92058&d=899184&f=ST) |
| decks/izzet-spellementals-899185.txt | Izzet Spellementals | Saturday ReCQ 3:00pm @ SCG CON Los Angeles (11/10/26, 58 players) - 5-8, Alexis Lopez | [link](https://www.mtgtop8.com/event?e=92058&d=899185&f=ST) |
| decks/jund-sacrifice-899186.txt | Jund Sacrifice | Saturday ReCQ 3:00pm @ SCG CON Los Angeles (11/10/26, 58 players) - 5-8, Austin Bench | [link](https://www.mtgtop8.com/event?e=92058&d=899186&f=ST) |
| decks/mardu-aggro-899188.txt | Mardu Aggro | Saturday ReCQ 3:00pm @ SCG CON Los Angeles (11/10/26, 58 players) - 5-8, Richard Henriques | [link](https://www.mtgtop8.com/event?e=92058&d=899188&f=ST) |
| decks/4-5c-control-899140.txt | 4/5C Control | RCQ @ Il Labirinto (Bollate, Milan) (11/10/26, 24 players) - 3-4, Simeoni Gianmarco | [link](https://www.mtgtop8.com/event?e=92053&d=899140&f=ST) |
| decks/reanimator-900565.txt | Reanimator | Champions Cup Premium Qualifier @ TC (Tokyo, Japan) (11/10/26, 127 players) - 2nd, Namchaisiri Charles | [link](https://www.mtgtop8.com/event?e=92221&d=900565&f=ST) |

## Pioneer

| File | Archetype | Event | Deck |
|---|---|---|---|
| pioneer/the-rock-900614.txt | The Rock | MTGO Challenge 32 (Pioneer), 12/10/26 (2026-10-12), 40 players, 1st place, Arianne | [link](https://www.mtgtop8.com/event?e=92227&d=900614&f=PI) |
| pioneer/ur-aggro-900615.txt | UR Aggro | MTGO Challenge 32 (Pioneer), 12/10/26 (2026-10-12), 40 players, 2nd place, Mirozel1 | [link](https://www.mtgtop8.com/event?e=92227&d=900615&f=PI) |
| pioneer/jund-900619.txt | Jund | MTGO Challenge 32 (Pioneer), 12/10/26 (2026-10-12), 40 players, 3rd-4th place, xfile | [link](https://www.mtgtop8.com/event?e=92227&d=900619&f=PI) |
| pioneer/red-deck-wins-900621.txt | Red Deck Wins | MTGO Challenge 32 (Pioneer), 12/10/26 (2026-10-12), 40 players, 3rd-4th place, manohito | [link](https://www.mtgtop8.com/event?e=92227&d=900621&f=PI) |
| pioneer/devotion-to-green-896064.txt | Devotion to Green | Revival RCQ @ Game Grid (UT) (Pioneer, paper), 02/10/26 (2026-10-02), 32 players, 3rd-4th place, Vivienne Blue | [link](https://www.mtgtop8.com/event?e=91661&d=896064&f=PI) |
| pioneer/lotus-field-896795.txt | Lotus Field | MTGO Challenge 32 (Pioneer), 05/10/26 (2026-10-05), 50 players, 5th-8th place, gurig | [link](https://www.mtgtop8.com/event?e=91734&d=896795&f=PI) |
| pioneer/izzet-control-898980.txt | Izzet Control | MTGO Challenge 16 (Pioneer), 10/10/26 (2026-10-10), 25 players, 2nd place, renatoaraujo | [link](https://www.mtgtop8.com/event?e=92037&d=898980&f=PI) |
| pioneer/enigmatic-incarnation-896066.txt | Enigmatic Incarnation | Revival RCQ @ Game Grid (UT) (Pioneer, paper), 02/10/26 (2026-10-02), 32 players, 5th-8th place, Brock Sorensen | [link](https://www.mtgtop8.com/event?e=91661&d=896066&f=PI) |
| pioneer/dimir-control-896067.txt | Dimir Control | Revival RCQ @ Game Grid (UT) (Pioneer, paper), 02/10/26 (2026-10-02), 32 players, 5th-8th place, Pkpower | [link](https://www.mtgtop8.com/event?e=91661&d=896067&f=PI) |

## Modern

| File | Archetype | Event | Deck |
|---|---|---|---|
| modern/esper-blink-900393.txt | Esper Blink | Regional Championship - CAMS - T13 @ Necrotower Gamecenter (Mexico, Mexico), 10/10/26 (2026-10-10), 184 players, #1, Allan Ayapan | [link](https://www.mtgtop8.com/event?e=92202&d=900393&f=MO) |
| modern/urzatron-900999.txt | UrzaTron | MTGO Challenge 32, 14/10/26 (2026-10-14), 44 players, #1, kthanakit26 | [link](https://www.mtgtop8.com/event?e=92282&d=900999&f=MO) |
| modern/amulet-titan-900437.txt | Amulet Titan | MTGO Challenge 32, 13/10/26 (2026-10-13), 44 players, 5-8, HouseOfManaMTG | [link](https://www.mtgtop8.com/event?e=92204&d=900437&f=MO) |
| modern/5c-domain-aggro-900436.txt | 5c Domain Aggro | MTGO Challenge 32, 13/10/26 (2026-10-13), 44 players, #1, Slasher21 | [link](https://www.mtgtop8.com/event?e=92204&d=900436&f=MO) |
| modern/living-end-899960.txt | Living End | Regional Championship - Ultimate Guard European Magic Series - Fanfinity @ Ghent (Belgium), 10/10/26 (2026-10-10), 1193 players, 3-4, Anthony Pav | [link](https://www.mtgtop8.com/event?e=92163&d=899960&f=MO) |
| modern/burn-900444.txt | Burn | MTGO Challenge 32, 13/10/26 (2026-10-13), 44 players, 3-4, Enida | [link](https://www.mtgtop8.com/event?e=92204&d=900444&f=MO) |
| modern/ur-murktide-900159.txt | UR Murktide | Regional Championship @ SCG CON Los Angeles, 10/10/26 (2026-10-10), 1228 players, 17-32, Zkg31 | [link](https://www.mtgtop8.com/event?e=92175&d=900159&f=MO) |
| modern/hammer-time-900459.txt | Hammer Time | MTGO Challenge 16, 13/10/26 (2026-10-13), 25 players, #2, hyoooga | [link](https://www.mtgtop8.com/event?e=92206&d=900459&f=MO) |
| modern/broodscale-bloodchief-899958.txt | Broodscale Bloodchief | Regional Championship - Ultimate Guard European Magic Series - Fanfinity @ Ghent (Belgium), 10/10/26 (2026-10-10), 1193 players, #1, Alexander Rosdahl | [link](https://www.mtgtop8.com/event?e=92163&d=899958&f=MO) |

## Duel Commander

| File | Commander | Event | Deck |
|---|---|---|---|
| duel/phelia-900951.txt | Phelia, Exuberant Shepherd | Narbogoyf Weekly #3 @ endstep, 14/10/26, 144 players, 1st place, Re Ojama | [link](https://www.mtgtop8.com/event?e=92274&d=900951&f=EDH) |
| duel/emry-900941.txt | Emry, Lurker of the Loch | Geek Factory X MTG94 @ Geek Factory (Nogent Sur Marne, France), 13/10/26, 15 players, 4th place, Jack S | [link](https://www.mtgtop8.com/event?e=92271&d=900941&f=EDH) |
| duel/phlage-900954.txt | Phlage, Titan of Fire's Fury | Narbogoyf Weekly #3 @ endstep, 14/10/26, 144 players, 3rd-4th place, S7eth | [link](https://www.mtgtop8.com/event?e=92274&d=900954&f=EDH) |
| duel/toph-900252.txt | Toph, Greatest Earthbender | MTGO League, 13/10/26, player count not shown, 2nd place (league list position), Shanks123 | [link](https://www.mtgtop8.com/event?e=92184&d=900252&f=EDH) |
| duel/ellie-partners-901254.txt | Ellie, Brick Master + Ellie, Vengeful Hunter | DC Italian Qualifier @ Games & Toys (Canelli, Italy), 11/10/26, 23 players, 1st place, Stefano Cavallo (deck name: Vorrei Ellieluminarti L'anima) | [link](https://www.mtgtop8.com/event?e=92317&d=901254&f=EDH) |
| duel/tasigur-901561.txt | Tasigur, the Golden Fang | BeerMander Ignifuga Event @ Ignifuga TCG Festival (Padova, Italy), 16/10/26, 36 players, 1st place, Matteo Blasi | [link](https://www.mtgtop8.com/event?e=92361&d=901561&f=EDH) |
| duel/jace-multiverse-architect-900953.txt | Jace, Multiverse Architect | Narbogoyf Weekly #3 @ endstep, 14/10/26, 144 players, 3rd-4th place, Bitzelberg | [link](https://www.mtgtop8.com/event?e=92274&d=900953&f=EDH) |
| duel/atraxa-901564.txt | Atraxa, Grand Unifier | BeerMander Ignifuga Event @ Ignifuga TCG Festival (Padova, Italy), 16/10/26, 36 players, 3rd-4th place, Marco Fanton | [link](https://www.mtgtop8.com/event?e=92361&d=901564&f=EDH) |
| duel/terra-901257.txt | Terra, Magical Adept | DC Italian Qualifier @ Games & Toys (Canelli, Italy), 11/10/26, 23 players, 3rd-4th place, Lorenzo Raviola (deck name: Terracotta 11/10) | [link](https://www.mtgtop8.com/event?e=92317&d=901257&f=EDH) |

## Commander

| File | Commander | Kind | Source | Deck |
|---|---|---|---|---|
| commander/lumra-901586.txt | Lumra, Bellow of the Woods | cEDH | Brain Freeze \| cEDH @ La Competència (Barberà del Vallès, Spain), 16/10/26 (2026-10-16), 15 players, 3rd-4th place, Dulcet | [link](https://www.mtgtop8.com/event?e=92366&d=901586&f=cEDH) |
| commander/kinnan-899241.txt | Kinnan, Bonder Prodigy | cEDH | Collectible Ventures: S.N.L. - Mages 10K Birthday Bash @ Mage's Sanctum (Waco, TX), 10/10/26 (2026-10-10), 94 players, 1st place, Dracius Mckee [dxtx] | [link](https://www.mtgtop8.com/event?e=92067&d=899241&f=cEDH) |
| commander/kefka-899242.txt | Kefka, Court Mage | cEDH | Collectible Ventures: S.N.L. - Mages 10K Birthday Bash @ Mage's Sanctum (Waco, TX), 10/10/26 (2026-10-10), 94 players, 2nd place, Bryce Snyder | [link](https://www.mtgtop8.com/event?e=92067&d=899242&f=cEDH) |
| commander/kraum-tymna-900288.txt | Kraum, Ludevic's Opus + Tymna the Weaver | cEDH | Grand cEDH Cup @ Win Condition Games (Kennesaw, GA), 11/10/26 (2026-10-11), 45 players, 1st place, Tkocho™ [hiq] | [link](https://www.mtgtop8.com/event?e=92190&d=900288&f=cEDH) |
| commander/sisay-900353.txt | Sisay, Weatherlight Captain | cEDH | $1K @ The Deck Factory (Lima, OH), 11/10/26 (2026-10-11), 38 players, 1st place, Logan "eddie" Smart | [link](https://www.mtgtop8.com/event?e=92196&d=900353&f=cEDH) |
| commander/syr-konrad-234654.txt | Syr Konrad, the Grim | casual | Archidekt deck "Syrah Konnor" by JoeyDH, updated 2026-06-03, about 125,600 views. The page was cut off before two cards: Night's Whisper and Sign in Blood were found with Archidekt's deck search and the deck's prices, not read from the list | [link](https://archidekt.com/decks/234654) |
| commander/endless-punishment-precon.txt | Valgavoth, Harrower of Souls | precon | Endless Punishment, Duskmourn Commander (2024), from mtg.wtf | [link](https://mtg.wtf/deck/dsc/endless-punishment) |
| commander/scions-spellcraft-precon.txt | Y'shtola, Night's Blessed | precon | Scions & Spellcraft, Final Fantasy Commander, from mtg.wtf; Archidekt's copy agrees | [link](https://mtg.wtf/deck/fic/scions-spellcraft-final-fantasy-xiv) |
| commander/dance-of-the-elements-precon.txt | Ashling, the Limitless | precon | Dance of the Elements, Lorwyn Eclipsed Commander, from mtg.wtf; Archidekt's copy agrees | [link](https://mtg.wtf/deck/ecc/dance-of-the-elements) |
