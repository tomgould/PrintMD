#!/usr/bin/env python3
"""
tests/fixtures/build-fixtures.py

Rebuilds the EPUB, Word and HTML fixtures used by tests/importers-docs.test.html.
The files are committed, so the tests never run this; run it only to change a
fixture, then update tests/fixtures/expected/*.md.

    python3 tests/fixtures/build-fixtures.py

encoded-names.epub  chapter files named with spaces and non-ASCII characters
                    (percent-encoded in the OPF), an author containing "$&" and
                    "$1", a table, and one chapter that is not well-formed XHTML
word-image.docx     a heading, bold text, two PNG images, bullet and numbered
                    lists, a table and a paragraph style mammoth does not know
aspnet.html         an ASP.NET-style page: everything inside <form runat="server">,
                    header and aside outside <main>, windows-1252 bytes and <meta charset>
password.pdf        a one-page PDF encrypted with the Standard security handler
                    (revision 2, 40-bit RC4); the user password is "bright"
bomb-lie.epub       zip bombs that lie: the chapter (or document.xml) inflates to
bomb-lie.docx       about 210 MB while the central directory says 1000 bytes
bomb-truncated.epub the same EPUB, but the end record's central-directory size
                    covers only the first entry, so a reader of that size sees one file
"""
import hashlib
import io
import os
import random
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
FIXED_TIME = (2026, 1, 1, 0, 0, 0)   # stable zip timestamps


def add(z, name, data, compress=zipfile.ZIP_DEFLATED):
    info = zipfile.ZipInfo(name, FIXED_TIME)
    info.compress_type = compress
    z.writestr(info, data.encode('utf-8') if isinstance(data, str) else data)


# ── EPUB ─────────────────────────────────────────────────────────────────────

CONTAINER = '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>'''

OPF = '''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:4a7f6c1e-0000-4000-8000-000000000001</dc:identifier>
    <dc:title>Encoded Names</dc:title>
    <dc:creator>Ana $&amp; Bo $1</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="Text/Chapter%20One.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/Kapitel%20Zwei%20%C3%BC.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="Text/broken.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>'''

NAV = '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="Text/Chapter%20One.xhtml">Chapter One</a></li></ol></nav></body></html>'''

CHAPTER_ONE = '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head>
<body>
<h1>Chapter One</h1>
<p>The first file is named <em>Chapter One.xhtml</em>, with a space.</p>
<table>
  <tr><th>Term</th><th>Meaning</th></tr>
  <tr><td><b>EPUB</b></td><td>A zip | of XHTML</td></tr>
  <tr><td><code>OPF</code></td><td>The <a href="https://www.w3.org/TR/epub-33/">package</a> file</td></tr>
</table>
</body></html>'''

CHAPTER_TWO = '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Kapitel Zwei</title></head>
<body>
<h2>Kapitel Zwei</h2>
<p>Grüße aus der zweiten Datei.</p>
<ul><li>Erstens</li><li>Zweitens</li></ul>
</body></html>'''

BROKEN = '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Unclosed paragraph<p>and a stray &nbsp; entity</body></html>'''


def build_epub():
    path = os.path.join(HERE, 'encoded-names.epub')
    with zipfile.ZipFile(path, 'w') as z:
        add(z, 'mimetype', 'application/epub+zip', zipfile.ZIP_STORED)   # first and stored
        add(z, 'META-INF/container.xml', CONTAINER)
        add(z, 'OEBPS/content.opf', OPF)
        add(z, 'OEBPS/nav.xhtml', NAV)
        add(z, 'OEBPS/Text/Chapter One.xhtml', CHAPTER_ONE)
        add(z, 'OEBPS/Text/Kapitel Zwei ü.xhtml', CHAPTER_TWO)
        add(z, 'OEBPS/Text/broken.xhtml', BROKEN)
    return path


# ── DOCX ─────────────────────────────────────────────────────────────────────

def png(width, height, pixels):
    """A truecolour PNG from a flat list of (r, g, b)."""
    raw = b''.join(b'\x00' + bytes(c for px in pixels[y * width:(y + 1) * width] for c in px) for y in range(height))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
PIC = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>'''

ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
</Relationships>'''

STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {W}>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="FancyQuote"><w:name w:val="Fancy Quote"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>'''

NUMBERING = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering {W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>'''


def para(text, style=None, num=None):
    ppr = ''
    if style or num:
        ppr = '<w:pPr>' + (f'<w:pStyle w:val="{style}"/>' if style else '') + \
              (f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num}"/></w:numPr>' if num else '') + '</w:pPr>'
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def image_para(rel, n, descr):
    return (f'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="457200" cy="457200"/>'
            f'<wp:docPr id="{n}" name="Picture {n}" descr="{descr}"/>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
            f'<pic:nvPicPr><pic:cNvPr id="{n}" name="image{n}.png" descr="{descr}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/>'
            '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')


def cell(inner):
    return f'<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>{inner}</w:tc>'


DOCUMENT = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {W} {R} {WP} {A} {PIC}><w:body>'
            + para('Quarterly Report', style='Heading1')
            + '<w:p><w:r><w:t xml:space="preserve">Revenue grew in </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>every</w:t></w:r>'
              '<w:r><w:t xml:space="preserve"> region.</w:t></w:r></w:p>'
            + image_para('rId3', 1, 'Company logo')
            + para('North', num=1) + para('South', num=1)
            + para('First step', num=2) + para('Second step', num=2)
            + '<w:tbl><w:tblPr><w:tblW w:w="4800" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>'
            + '<w:tr>' + cell(para('Region')) + cell(para('Sales')) + '</w:tr>'
            + '<w:tr>' + cell('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>North</w:t></w:r></w:p>') + cell(para('A | B')) + '</w:tr>'
            + '<w:tr>' + cell(para('South')) + cell(para('120')) + '</w:tr>'
            + '</w:tbl>'
            + para('A styled paragraph.', style='FancyQuote')
            + image_para('rId4', 2, 'Sales chart')
            + '<w:sectPr/></w:body></w:document>')


def build_docx():
    rnd = random.Random(5)
    logo = png(1, 1, [(200, 30, 40)])
    chart = png(20, 20, [(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(400)])
    path = os.path.join(HERE, 'word-image.docx')
    with zipfile.ZipFile(path, 'w') as z:
        add(z, '[Content_Types].xml', CONTENT_TYPES)
        add(z, '_rels/.rels', ROOT_RELS)
        add(z, 'word/_rels/document.xml.rels', DOC_RELS)
        add(z, 'word/document.xml', DOCUMENT)
        add(z, 'word/styles.xml', STYLES)
        add(z, 'word/numbering.xml', NUMBERING)
        add(z, 'word/media/logo.png', logo, zipfile.ZIP_STORED)
        add(z, 'word/media/chart.png', chart, zipfile.ZIP_STORED)
    return path


# ── ASP.NET-style HTML in windows-1252 ───────────────────────────────────────

ASPNET = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="windows-1252">
<title>Quarterly Update | Example Co</title>
</head>
<body>
<form method="post" action="./Default.aspx" id="form1" runat="server">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKLTk1NjU0MzIxMmRk">
<header class="site-header"><a href="/">Example Co</a> <span>Investor site</span></header>
<nav><a href="/">Home</a> <a href="/news">News</a></nav>
<aside class="sidebar"><h3>Related</h3><p>Older updates</p></aside>
<main id="MainContent">
<article>
<header><h1>Quarterly Update</h1><p class="byline">By Zoë Brontë, 3 March</p></header>
<p>Revenue rose to €1.2m, a “strong” quarter for the café chain.</p>
<aside class="pullquote"><p>Margins held at 12½%.</p></aside>
<table>
<tr><th>Region</th><th>Revenue</th></tr>
<tr><td>North</td><td>€0.7m</td></tr>
<tr><td>South</td><td>€0.5m</td></tr>
</table>
<p>Questions? <a href="mailto:ir@example.com">Email investor relations</a>.</p>
<button type="submit">Subscribe</button>
</article>
</main>
<footer><p>© Example Co. All rights reserved.</p></footer>
</form>
</body>
</html>
'''


def build_html():
    path = os.path.join(HERE, 'aspnet.html')
    with open(path, 'wb') as f:
        f.write(ASPNET.encode('cp1252'))
    return path


# ── Password-protected PDF (PDF 1.4 Standard security handler, R2) ───────────

PAD = bytes.fromhex('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A')


def rc4(key, data):
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    i = j = 0
    out = bytearray()
    for byte in data:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        out.append(byte ^ s[(s[i] + s[j]) % 256])
    return bytes(out)


def padded(password):
    return (password.encode('latin-1') + PAD)[:32]


def build_password_pdf(user='bright', owner='bright-owner'):
    file_id = hashlib.md5(b'printmd-password-fixture').digest()
    perms = -44   # print and copy allowed; the value only has to be consistent
    o_value = rc4(hashlib.md5(padded(owner)).digest()[:5], padded(user))          # algorithm 3.3
    key = hashlib.md5(padded(user) + o_value + struct.pack('<i', perms) + file_id).digest()[:5]   # 3.2
    u_value = rc4(key, PAD)                                                         # 3.4

    def object_key(num, gen=0):
        return hashlib.md5(key + struct.pack('<i', num)[:3] + struct.pack('<i', gen)[:2]).digest()[:10]

    content = (b'BT /F1 24 Tf 72 720 Td (Protected Report) Tj ET\n'
               b'BT /F1 12 Tf 72 690 Td (This text is behind a password.) Tj ET\n'
               b'BT /F1 12 Tf 72 670 Td (It opens with the user password.) Tj ET\n'
               b'BT /F1 12 Tf 72 650 Td (Nothing else is on the page.) Tj ET')
    stream = rc4(object_key(4), content)
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Filter /Standard /V 1 /R 2 /O <' + o_value.hex().encode() + b'> /U <' + u_value.hex().encode()
        + b'> /P %d >>' % perms,
    ]
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % n + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    out += b''.join(b'%010d 00000 n \n' % o for o in offsets)
    hex_id = file_id.hex().encode()
    out += (b'trailer\n<< /Size %d /Root 1 0 R /Encrypt 6 0 R /ID [<' % (len(objects) + 1) + hex_id + b'> <' + hex_id
            + b'>] >>\nstartxref\n%d\n%%%%EOF\n' % xref)
    path = os.path.join(HERE, 'password.pdf')
    with open(path, 'wb') as f:
        f.write(bytes(out))
    return path


# ── Zip bombs whose central directory lies ───────────────────────────────────

BOMB_MB = 210


def bomb_zip(kind):
    """A small zip whose one big entry inflates to about BOMB_MB megabytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compresslevel=9) as z:
        if kind == 'epub':
            add(z, 'mimetype', 'application/epub+zip', zipfile.ZIP_STORED)
            add(z, 'META-INF/container.xml', CONTAINER)
            add(z, 'OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
                '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Bomb</dc:title></metadata>'
                '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
                '<spine><itemref idref="c1"/></spine></package>')
            unit = b'<p>' + b'a' * 1000 + b'</p>\n'
            body = unit * (BOMB_MB * 1024 * 1024 // len(unit))
            add(z, 'OEBPS/c1.xhtml', b'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>'
                + body + b'</body></html>')
        else:
            add(z, '[Content_Types].xml', CONTENT_TYPES)
            add(z, '_rels/.rels', ROOT_RELS)
            unit = b'<w:p><w:r><w:t>' + b'a' * 1000 + b'</w:t></w:r></w:p>'
            body = unit * (BOMB_MB * 1024 * 1024 // len(unit))
            add(z, 'word/document.xml', f'<?xml version="1.0"?><w:document {W}><w:body>'.encode() + body
                + b'</w:body></w:document>')
    return bytearray(buf.getvalue())


def central_directory(data):
    eocd = data.rfind(b'PK\x05\x06')
    cd_size, cd_off = struct.unpack_from('<II', data, eocd + 12)
    return eocd, cd_size, cd_off


def lie_about_sizes(data):
    """Make every central-directory entry over 1 MB claim 1000 bytes uncompressed."""
    _, _, p = central_directory(data)
    while data[p:p + 4] == b'PK\x01\x02':
        if struct.unpack_from('<I', data, p + 24)[0] > 1000000:
            struct.pack_into('<I', data, p + 24, 1000)
        n, e, c = struct.unpack_from('<HHH', data, p + 28)
        p += 46 + n + e + c
    return data


def truncate_central_directory(data):
    """Make the end record's central-directory size cover only the first entry."""
    eocd, _, cd_off = central_directory(data)
    n, e, c = struct.unpack_from('<HHH', data, cd_off + 28)
    struct.pack_into('<I', data, eocd + 12, 46 + n + e + c)
    return data


def build_bombs():
    paths = []
    for name, data in (('bomb-lie.epub', lie_about_sizes(bomb_zip('epub'))),
                       ('bomb-lie.docx', lie_about_sizes(bomb_zip('docx'))),
                       ('bomb-truncated.epub', truncate_central_directory(bomb_zip('epub')))):
        path = os.path.join(HERE, name)
        with open(path, 'wb') as f:
            f.write(bytes(data))
        paths.append(path)
    return paths


if __name__ == '__main__':
    for p in (build_epub(), build_docx(), build_html(), build_password_pdf(), *build_bombs()):
        print('wrote', os.path.basename(p), os.path.getsize(p), 'bytes')
