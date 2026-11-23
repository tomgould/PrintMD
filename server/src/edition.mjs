// The edition switch for the PDF API. The public edition's build changes allowHostedApi to false, which makes
// main.mjs refuse every hosted setting. Keep this file tiny: the build edits that one value.
export const EDITION = Object.freeze({allowHostedApi: false});
