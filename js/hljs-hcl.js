/**
 * hljs-hcl.js
 * A small highlight.js grammar for HCL (Terraform, OpenTofu, Packer, Nomad).
 * highlight.js ships no HCL grammar, so this one is ours: comments, strings
 * with ${...} interpolation, heredocs, numbers, literals, block types,
 * attribute names and function calls.
 *
 * Linear on any input (tests/code-languages.test.mjs checks growth on hostile
 * ones): every identifier run is consumed as one token, so no pattern starts
 * again inside a run such as "a-a-a-...". No regex lookbehind, which Safari
 * before 16.4 cannot parse.
 *
 * Registered by js/code-languages.js: hljs.registerLanguage('hcl', hcl).
 * @param {object} hljs  the highlight.js API
 * @returns {object} a highlight.js language definition
 */
export default function hcl(hljs) {
    const LITERALS = 'true false null';
    const BLOCKS = [
        'resource', 'data', 'module', 'variable', 'output', 'locals', 'provider', 'terraform',
        'backend', 'required_providers', 'provisioner', 'connection', 'lifecycle', 'dynamic',
        'content', 'moved', 'import', 'check', 'removed', 'source', 'build', 'job', 'group', 'task',
    ];
    // An identifier run ends at a character outside [A-Za-z0-9_-]; "(?![\w-])" keeps a word
    // such as "in" from matching the start of "in-place".
    const END = '(?![A-Za-z0-9_-])';
    const INTERPOLATION = {
        className: 'subst',
        begin: /\$\{/,
        end: /\}/,
        keywords: {literal: LITERALS, keyword: 'for in if else endif endfor'},
        contains: [hljs.NUMBER_MODE, {className: 'string', begin: /"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE]}],
    };
    const STRING = {
        className: 'string',
        begin: /"/,
        end: /"/,
        contains: [hljs.BACKSLASH_ESCAPE, INTERPOLATION],
    };
    // <<TAG ends at a line holding exactly TAG; <<-TAG also allows the line to be indented.
    const HEREDOC = {
        className: 'string',
        begin: /<<(-?)([A-Za-z_][A-Za-z0-9_]*)$/,
        end: /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)$/,
        'on:begin': (m, resp) => {
            resp.data._tag = m[2];
            resp.data._indent = m[1] === '-';
        },
        'on:end': (m, resp) => {
            if (m[2] !== resp.data._tag || (m[1] && !resp.data._indent)) resp.ignoreMatch();
        },
        contains: [INTERPOLATION],
    };
    return {
        name: 'HCL',
        aliases: ['terraform', 'tf', 'tfvars'],
        contains: [
            hljs.HASH_COMMENT_MODE,
            hljs.C_LINE_COMMENT_MODE,
            hljs.C_BLOCK_COMMENT_MODE,
            HEREDOC,
            STRING,
            {className: 'keyword', match: new RegExp(`^[ \\t]*(?:${BLOCKS.join('|')})${END}`, 'm')},
            {className: 'literal', match: new RegExp(`(?:true|false|null)${END}`)},
            {className: 'keyword', match: new RegExp(`(?:for|in|if|else)${END}`)},
            {className: 'type', match: new RegExp(`(?:string|number|bool|any|list|map|set|object|tuple)${END}(?![ \\t]*=)`)},
            {className: 'variable', match: /(?:var|local|module|data|each|count|path|self)(?=\.)/},
            {className: 'title.function', match: /[a-z_][a-z0-9_]*(?=\()/},
            {className: 'attr', match: /[A-Za-z_][A-Za-z0-9_-]*(?=[ \t]*=(?!=))/},
            // Any other identifier run, consumed whole and left plain: the rules above then
            // only ever try a run from its first character.
            {match: /[A-Za-z_][A-Za-z0-9_-]*/},
            hljs.NUMBER_MODE,
        ],
    };
}
