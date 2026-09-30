#!/usr/bin/env python3
"""Conservative Fastmail CardDAV group edits. No contact creation or rewriting.

Uses only the standard library. Mutations default to preview; --apply is explicit.
Secrets come from the environment and never appear in arguments or results.
"""
import argparse
import base64
from collections import Counter
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ORIGIN = "https://carddav.fastmail.com"
DAV = "DAV:"
CARD = "urn:ietf:params:xml:ns:carddav"
MAX_BYTES = 16 * 1024 * 1024
MEMBER_KEYS = {"MEMBER", "X-ADDRESSBOOKSERVER-MEMBER"}


class ContactGroupsError(Exception):
    pass


def member_ref(uid):
    match = re.fullmatch(r"(?:urn:uuid:)?([A-Za-z0-9._@+\-]{1,200})", uid, re.I) if isinstance(uid, str) else None
    if not match:
        raise ContactGroupsError("Unsupported contact UID; no changes made.")
    value = "urn:uuid:" + match[1]
    # UUID hex is case-insensitive; arbitrary non-UUID identifiers are not.
    if re.fullmatch(r"urn:uuid:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value):
        value = value.lower()
    return value


def unescape(value):
    return re.sub(r"\\([nN,;\\])", lambda m: "\n" if m[1] in "nN" else m[1], value)


def parse_card(text):
    records = []
    for physical in text.splitlines(keepends=True):
        logical = physical.rstrip("\r\n")
        if logical.startswith((" ", "\t")):
            if not records:
                raise ContactGroupsError("Malformed folded vCard.")
            records[-1]["line"] += logical[1:]
            records[-1]["raw"] += physical
        else:
            records.append({"line": logical, "raw": physical})
    if len(records) < 4 or records[0]["line"].upper() != "BEGIN:VCARD" or records[-1]["line"].upper() != "END:VCARD":
        raise ContactGroupsError("Expected exactly one complete vCard.")
    values = {}
    for record in records:
        line = record["line"]
        quoted = False
        separator = None
        for i, char in enumerate(line):
            if char == '"' and (i == 0 or line[i - 1] != "\\"):
                quoted = not quoted
            elif char == ":" and not quoted:
                separator = i
                break
        if separator is None:
            raise ContactGroupsError("Malformed vCard property.")
        key = line[:separator].split(";", 1)[0].rsplit(".", 1)[-1].upper()
        record.update(key=key, header=line[:separator], value=line[separator + 1:])
        values.setdefault(key, []).append(unescape(record["value"]))
    if values.get("BEGIN") != ["VCARD"] or values.get("END") != ["VCARD"] or len(values.get("UID", [])) != 1:
        raise ContactGroupsError("Invalid or ambiguous vCard identity.")
    if values.get("VERSION") not in (["3.0"], ["4.0"]):
        raise ContactGroupsError("Unsupported vCard version.")
    kinds = values.get("KIND", []) + values.get("X-ADDRESSBOOKSERVER-KIND", [])
    members = [r["value"] for r in records if r["key"] in MEMBER_KEYS]
    return {
        "uid": values["UID"][0], "name": (values.get("FN") or [""])[0],
        "version": values["VERSION"][0], "is_group": bool(kinds) and all(k.lower() == "group" for k in kinds),
        "emails": values.get("EMAIL", []), "members": members, "records": records,
    }


def normalized_ref(value):
    try:
        return member_ref(value)
    except ContactGroupsError:
        return value  # Preserve other valid URI member types without interpreting them.


def fold(line, newline):
    chunks, current, size = [], "", 0
    for char in line:
        width = len(char.encode("utf-8"))
        if size + width > 75:
            chunks.append(current)
            current, size = " ", 1
        current += char
        size += width
    chunks.append(current)
    return newline.join(chunks) + newline


def change_membership(text, uid, action):
    if action not in ("add", "remove"):
        raise ContactGroupsError("Expected add or remove.")
    card = parse_card(text)
    if not card["is_group"]:
        raise ContactGroupsError("Target is not a contact group.")
    target = member_ref(uid)
    matching = [r for r in card["records"] if r["key"] in MEMBER_KEYS and normalized_ref(r["value"]) == target]
    if (action == "add" and matching) or (action == "remove" and not matching):
        return text
    if action == "remove":
        return "".join(r["raw"] for r in card["records"] if r not in matching)
    newline = "\r\n" if "\r\n" in card["records"][0]["raw"] else "\n"
    key = "MEMBER" if card["version"] == "4.0" else "X-ADDRESSBOOKSERVER-MEMBER"
    records = card["records"]
    return "".join(r["raw"] for r in records[:-1]) + fold(key + ":" + target, newline) + records[-1]["raw"]


def verify_edit(before, after, uid, action):
    old, new = parse_card(before), parse_card(after)
    target = member_ref(uid)
    old_members = Counter(normalized_ref(x) for x in old["members"])
    new_members = Counter(normalized_ref(x) for x in new["members"])
    if old["uid"] != new["uid"] or not new["is_group"]:
        raise ContactGroupsError("Group identity changed during verification.")
    if bool(new_members[target]) != (action == "add"):
        raise ContactGroupsError("Requested membership was not verified.")
    del old_members[target]
    del new_members[target]
    if old_members != new_members:
        raise ContactGroupsError("Unrelated group membership changed during verification.")
    def unrelated_member_properties(card):
        return Counter((r["header"], normalized_ref(r["value"])) for r in card["records"]
                       if r["key"] in MEMBER_KEYS and normalized_ref(r["value"]) != target)
    if unrelated_member_properties(old) != unrelated_member_properties(new):
        raise ContactGroupsError("Unrelated member properties changed during verification.")
    # Servers may update REV or fold lines differently; compare unfolded properties.
    def other_properties(card):
        return Counter(r["line"] for r in card["records"] if r["key"] not in MEMBER_KEYS | {"REV"})
    if other_properties(old) != other_properties(new):
        raise ContactGroupsError("Unrelated group properties changed during verification.")


def checked_url(href):
    url = urllib.parse.urljoin(ORIGIN + "/", href)
    parts = urllib.parse.urlsplit(url)
    decoded_path = urllib.parse.unquote(parts.path)
    if (parts.scheme != "https" or parts.netloc != "carddav.fastmail.com" or parts.username or parts.password
            or parts.query or parts.fragment or not decoded_path.startswith("/dav/addressbooks/user/")
            or any(p in (".", "..") for p in decoded_path.split("/")) or "\\" in decoded_path
            or any(ord(c) < 32 for c in decoded_path)):
        raise ContactGroupsError("Rejected unexpected CardDAV resource URL.")
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpDav:
    def __init__(self, username, password):
        if not username or ":" in username or any(ord(c) < 32 or ord(c) == 127 for c in username):
            raise ContactGroupsError("Configure FASTMAIL_USERNAME with the Fastmail account for Contacts access.")
        if not password:
            raise ContactGroupsError("Configure FASTMAIL_APP_PASSWORD with Contacts access.")
        self.authorization = "Basic " + base64.b64encode((username + ":" + password).encode()).decode()
        self.opener = urllib.request.build_opener(NoRedirect())

    def __call__(self, method, url, body=None, headers=None):
        url = checked_url(url)
        request = urllib.request.Request(url, data=body.encode("utf-8") if body is not None else None, method=method,
            headers={**(headers or {}), "Authorization": self.authorization})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ContactGroupsError("CardDAV response exceeds the safety limit; narrow the query.")
                return response.status, dict(response.headers.items()), raw.decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code == 412:
                raise ContactGroupsError("CardDAV conflict (412): group changed; re-read before retrying.") from None
            if error.code in (401, 403):
                raise ContactGroupsError(f"CardDAV access denied ({error.code}); check the app password's Contacts access.") from None
            raise ContactGroupsError(f"CardDAV {method} failed (HTTP {error.code}); no redirects followed.") from None
        except (urllib.error.URLError, TimeoutError, UnicodeError, OSError):
            # Do not echo exception text, server bodies, URLs, or credentials.
            raise ContactGroupsError(f"CardDAV {method} failed due to a network/encoding error.") from None


def xml_responses(text):
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise ContactGroupsError("Unsafe XML declaration in CardDAV response.")
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        raise ContactGroupsError("Invalid CardDAV XML response.") from None
    if root.tag != f"{{{DAV}}}multistatus":
        raise ContactGroupsError("Expected a DAV multistatus response.")
    rows = []
    for response in root.findall(f"{{{DAV}}}response"):
        href = response.findtext(f"{{{DAV}}}href")
        if not href:
            raise ContactGroupsError("CardDAV response omitted a resource URL.")
        props = {}
        for block in response.findall(f"{{{DAV}}}propstat"):
            status = block.findtext(f"{{{DAV}}}status", "")
            if not re.search(r"\s200(?:\s|$)", status):
                raise ContactGroupsError("Incomplete CardDAV property response; refusing a partial lookup.")
            prop = block.find(f"{{{DAV}}}prop")
            if prop is not None:
                props.update({child.tag: child for child in prop})
        if not props:
            raise ContactGroupsError("CardDAV resource is unreadable; refusing a partial lookup.")
        rows.append((checked_url(href), props))
    return rows


def xml_body(root):
    return ET.tostring(root, encoding="unicode")


class GroupService:
    def __init__(self, username, transport):
        self.home = checked_url(f"{ORIGIN}/dav/addressbooks/user/{urllib.parse.quote(username, safe='')}/")
        self.transport = transport

    def xml_request(self, method, url, body, depth="1"):
        status, _, text = self.transport(method, checked_url(url), body, {"Content-Type": "application/xml; charset=utf-8", "Depth": depth})
        if status != 207:
            raise ContactGroupsError(f"Unexpected CardDAV {method} response ({status}).")
        return xml_responses(text)

    def books(self):
        root = ET.Element(f"{{{DAV}}}propfind")
        prop = ET.SubElement(root, f"{{{DAV}}}prop")
        ET.SubElement(prop, f"{{{DAV}}}resourcetype")
        # Request only required properties: optional displayname may return 404.
        rows = self.xml_request("PROPFIND", self.home, xml_body(root))
        books = []
        for url, props in rows:
            resource_type = props.get(f"{{{DAV}}}resourcetype")
            if resource_type is not None and resource_type.find(f"{{{CARD}}}addressbook") is not None:
                books.append(url)
        if not books:
            raise ContactGroupsError("No readable CardDAV address books discovered.")
        return list(dict.fromkeys(books))

    def query(self, book, fields, value):
        root = ET.Element(f"{{{CARD}}}addressbook-query")
        prop = ET.SubElement(root, f"{{{DAV}}}prop")
        ET.SubElement(prop, f"{{{DAV}}}getetag")
        ET.SubElement(prop, f"{{{CARD}}}address-data")
        filt = ET.SubElement(root, f"{{{CARD}}}filter", {"test": "anyof"})
        for field in fields:
            pf = ET.SubElement(filt, f"{{{CARD}}}prop-filter", {"name": field})
            ET.SubElement(pf, f"{{{CARD}}}text-match", {"collation": "i;unicode-casemap", "match-type": "equals"}).text = value
        rows = self.xml_request("REPORT", book, xml_body(root))
        cards = []
        for url, props in rows:
            if not url.startswith(book.rstrip("/") + "/"):
                raise ContactGroupsError("CardDAV query returned a resource outside its address book.")
            data = props.get(f"{{{CARD}}}address-data")
            etag = props.get(f"{{{DAV}}}getetag")
            if data is None or not data.text:
                raise ContactGroupsError("CardDAV query omitted vCard data.")
            card = parse_card(data.text)
            card.update(url=url, book=book, etag=etag.text if etag is not None else None, raw=data.text)
            cards.append(card)
        return cards

    def execute(self, action, group=None, email=None, contact_uid=None, apply=False):
        if action not in ("list", "get", "add", "remove"):
            raise ContactGroupsError("Unknown action.")
        if apply and action not in ("add", "remove"):
            raise ContactGroupsError("apply is only valid for add/remove.")
        if action != "list" and not group:
            raise ContactGroupsError("group (exact name or CardDAV UID) is required.")
        if action in ("add", "remove") and not (email or contact_uid):
            raise ContactGroupsError("email or contactUid is required.")
        if email and ("@" not in email or any(c.isspace() for c in email)):
            raise ContactGroupsError("Use one exact email address.")
        if contact_uid:
            member_ref(contact_uid)
        books = self.books()
        groups = [g for b in books for g in self.query(b, ["KIND", "X-ADDRESSBOOKSERVER-KIND"], "group") if g["is_group"]]
        def summary(g):
            return {"uid": g["uid"], "name": g["name"], "memberCount": len(g["members"])}
        if action == "list":
            return {"summary": f"Found {len(groups)} contact groups.", "groups": [summary(g) for g in groups[:50]], "total": len(groups), "truncated": len(groups) > 50}
        by_uid = [g for g in groups if g["uid"] == group]
        matches = by_uid or [g for g in groups if g["name"].casefold() == group.casefold()]
        if len(matches) != 1:
            raise ContactGroupsError("Group missing or ambiguous; list groups and use a unique CardDAV UID.")
        selected = matches[0]
        result = {"summary": f"Group: {selected['name']} ({len(selected['members'])} members).", "group": summary(selected)}
        if not (email or contact_uid):
            return result
        field, value = ("UID", contact_uid) if contact_uid else ("EMAIL", email)
        contacts = [c for b in books for c in self.query(b, [field], value) if not c["is_group"]]
        contacts = [c for c in contacts if (not contact_uid or c["uid"] == contact_uid)
                    and (not email or email.casefold() in [e.casefold() for e in c["emails"]])]
        if len(contacts) != 1:
            raise ContactGroupsError("Contact missing or ambiguous; use a unique CardDAV contactUid or resolve the contact first. No contact was created.")
        contact = contacts[0]
        if contact["book"] != selected["book"]:
            raise ContactGroupsError("Contact and group are in different address books; refusing cross-book membership.")
        target = member_ref(contact["uid"])
        memberships = [summary(g) for g in groups if target in [normalized_ref(x) for x in g["members"]]]
        result.update(contact={"uid": contact["uid"], "name": contact["name"], "emails": contact["emails"]},
                      isMember=target in [normalized_ref(x) for x in selected["members"]], currentGroups=memberships)
        result["membershipScope"] = "whole-contact"
        if len(contact["emails"]) > 1:
            result["warning"] = f"Group membership can affect all {len(contact['emails'])} email addresses on this contact. Confirm the entire contact belongs in this group."
        if action == "get":
            return result
        # Fresh GET immediately before read/modify/write, with the actual server ETag.
        status, headers, before = self.transport("GET", selected["url"])
        if status != 200:
            raise ContactGroupsError("Could not read the current group resource.")
        current = parse_card(before)
        if not current["is_group"] or current["uid"] != selected["uid"] or current["name"] != selected["name"]:
            raise ContactGroupsError("Group identity changed; re-read before retrying.")
        after = change_membership(before, contact["uid"], action)
        result.update(group=summary(current), isMember=target in [normalized_ref(x) for x in current["members"]],
                      changed=False, wouldChange=before != after, applied=False, verified=False)
        if before == after:
            result.update(summary="Membership already has the requested state; no write needed.", verified=True)
            return result
        if not apply:
            result.update(summary=f"Would {action} {email or contact['uid']} {'to' if action == 'add' else 'from'} {current['name']}. Other groups and contact details stay unchanged.")
            return result
        etag = next((v for k, v in headers.items() if k.lower() == "etag"), None)
        if not isinstance(etag, str) or not re.fullmatch(r'"[^"\r\n]+"', etag):
            raise ContactGroupsError("A strong ETag is required; refusing an unsafe write.")
        try:
            status, _, _ = self.transport("PUT", selected["url"], after, {"Content-Type": "text/vcard; charset=utf-8", "If-Match": etag})
        except ContactGroupsError as error:
            if "(412)" in str(error) or "access denied" in str(error):
                raise
            raise ContactGroupsError("Group write outcome is uncertain; re-read before retrying. No automatic retry.") from None
        if status not in (200, 204):
            raise ContactGroupsError(f"Unexpected write response ({status}); re-read before retrying.")
        try:
            status, _, saved = self.transport("GET", selected["url"])
            if status != 200:
                raise ContactGroupsError("Read-back failed.")
            verify_edit(before, saved, contact["uid"], action)
        except ContactGroupsError:
            raise ContactGroupsError("Group was written, but verification failed; inspect its current state before retrying.") from None
        result.update(summary=f"Verified: {email or contact['uid']} {'added to' if action == 'add' else 'removed from'} {current['name']}.",
                      group=summary(parse_card(saved)), isMember=action == "add", changed=True, applied=True, verified=True)
        # currentGroups is the pre-write snapshot, not a claim about the final state.
        result["previousGroups"] = result.pop("currentGroups")
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["list", "get", "add", "remove"])
    parser.add_argument("--group")
    parser.add_argument("--email")
    parser.add_argument("--contact-uid")
    parser.add_argument("--apply", action="store_true", help="Apply an explicitly approved membership change (default: preview)")
    args = parser.parse_args(argv)
    try:
        username = os.environ.get("FASTMAIL_USERNAME") or ""
        if any(ord(c) < 32 or ord(c) == 127 for c in username):
            raise ContactGroupsError("Configure FASTMAIL_USERNAME with the Fastmail account for Contacts access.")
        username = username.strip()
        transport = HttpDav(username, os.environ.get("FASTMAIL_APP_PASSWORD"))
        result = GroupService(username, transport).execute(args.action, args.group, args.email, args.contact_uid, args.apply)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ContactGroupsError as error:
        print(json.dumps({"error": str(error)}))
        return 1
    except Exception:
        # Unexpected library exceptions must not leak raw responses or credentials.
        print(json.dumps({"error": "Unexpected contact-group error; no automatic retry. Re-read live state before retrying a write."}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
