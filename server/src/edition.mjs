// The edition switch for the PDF API. allowHostedApi: false makes main.mjs refuse every hosted setting, so the
// service only runs on your own computer. Keep this file tiny: the flag is the whole contract.
export const EDITION = Object.freeze({allowHostedApi: false});
