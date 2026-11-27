// Gli scrittori provvisori del seed sono stati sostituiti dai comandi veri: consensi e
// scelte in `seed/consents.ts`. Qui resta solo il tipo dell'indirizzo, condiviso dai dati del seed.

/** Un indirizzo inventato del seed, in Italia. */
export type SeedAddress = { line: string; postalCode: string; city: string; province: string };
