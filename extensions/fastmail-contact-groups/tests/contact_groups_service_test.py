"""Offline service/HTTP contracts; every transport and HTTP opener is mocked."""
import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "contact_groups_service_under_test", pathlib.Path(__file__).parents[1] / "contact-groups.py"
)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

USERNAME = "test@example.test"
HOME = m.ORIGIN + "/dav/addressbooks/user/test%40example.test/"
BOOK = HOME + "default/"
SECOND_BOOK = HOME + "other/"
GROUP_URL = BOOK + "group.vcf"
CONTACT_URL = BOOK + "contact.vcf"
UID = "12345678-1234-1234-1234-123456789abc"
OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
EMAIL = "person@example.test"
SECRET = "NEVER-EXPOSE-test-password"
SERVER_TEXT = "PRIVATE-REMOTE-BODY"


def group_card(uid="group-uid", name="Paperwork", members=(OTHER,)):
    return "\r\n".join([
        "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + name,
        "X-ADDRESSBOOKSERVER-KIND:group", 'X-KEEP;LABEL="a:b":untouched',
        "NOTE:first part", " second part", "REV:20260909T120000Z",
        *["X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:" + member for member in members],
        "END:VCARD", "",
    ])


def contact_card(uid=UID, email=EMAIL):
    return "\r\n".join([
        "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:Person",
        "EMAIL;TYPE=INTERNET:" + email, "END:VCARD", "",
    ])


def added_card(before, uid=UID):
    # Expected output is constructed independently of change_membership.
    return before.replace("END:VCARD", "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:" + uid + "\r\nEND:VCARD")


def multistatus(rows):
    """Rows are (href, card); card=None represents an address book."""
    root = ET.Element("{" + m.DAV + "}multistatus")
    for href, card in rows:
        response = ET.SubElement(root, "{" + m.DAV + "}response")
        ET.SubElement(response, "{" + m.DAV + "}href").text = href
        block = ET.SubElement(response, "{" + m.DAV + "}propstat")
        ET.SubElement(block, "{" + m.DAV + "}status").text = "HTTP/1.1 200 OK"
        prop = ET.SubElement(block, "{" + m.DAV + "}prop")
        if card is None:
            resource = ET.SubElement(prop, "{" + m.DAV + "}resourcetype")
            ET.SubElement(resource, "{" + m.CARD + "}addressbook")
        else:
            ET.SubElement(prop, "{" + m.DAV + "}getetag").text = '"stale-report-etag"'
            ET.SubElement(prop, "{" + m.CARD + "}address-data").text = card
    return ET.tostring(root, encoding="unicode")


class FakeDav:
    def __init__(self, before=None):
        self.books = [BOOK]
        self.groups = {BOOK: [(GROUP_URL, group_card())]}
        self.contacts = {BOOK: [(CONTACT_URL, contact_card())]}
        self.before = group_card() if before is None else before
        self.etag_headers = {"eTaG": '"fresh-get-etag"'}
        self.put_result = (204, {}, "")
        self.verify_result = None
        self.fresh_status = 200
        self.calls = []
        self.saved = None
        self.get_count = 0

    def __call__(self, method, url, body=None, headers=None):
        self.calls.append((method, url, body, headers))
        if method == "PROPFIND":
            assert url == HOME, url
            return 207, {}, multistatus([(book, None) for book in self.books])
        if method == "REPORT":
            assert url in self.books, url
            fields = [p.attrib["name"] for p in ET.fromstring(body).iter("{" + m.CARD + "}prop-filter")]
            rows = self.groups if "KIND" in fields else self.contacts
            return 207, {}, multistatus(rows.get(url, []))
        if method == "GET":
            assert url == GROUP_URL, url
            self.get_count += 1
            result = ((self.fresh_status, self.etag_headers, self.before) if self.get_count == 1
                      else self.verify_result if self.verify_result is not None
                      else (200, {"ETag": '"after-put"'}, self.saved))
            if isinstance(result, Exception):
                raise result
            return result
        if method == "PUT":
            assert url == GROUP_URL, url
            self.saved = body
            if isinstance(self.put_result, Exception):
                raise self.put_result
            return self.put_result
        raise AssertionError("Unexpected transport method: " + method)

    @property
    def writes(self):
        return [call for call in self.calls if call[0] not in ("PROPFIND", "REPORT", "GET")]


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.dav = FakeDav()
        self.service = m.GroupService(USERNAME, self.dav)

    def execute(self, action="add", **kwargs):
        return self.service.execute(action, group="Paperwork", email=EMAIL, **kwargs)

    def test_group_renamed_since_lookup_refuses_write(self):
        self.dav.before = group_card(name="Feed")
        with self.assertRaisesRegex(m.ContactGroupsError, "identity changed"):
            self.execute(apply=True)
        self.assertEqual(self.dav.writes, [])

    def test_preview_warns_that_membership_affects_all_contact_addresses(self):
        self.dav.contacts[BOOK] = [(CONTACT_URL, contact_card().replace("END:VCARD", "EMAIL:second@example.test\r\nEND:VCARD"))]
        result = self.execute()
        self.assertIn("all 2 email addresses", result["warning"])
        self.assertEqual(result["membershipScope"], "whole-contact")
        self.assertEqual(self.dav.writes, [])

    def test_preview_defaults_to_zero_writes_and_fresh_get(self):
        result = self.execute()
        self.assertEqual(self.dav.writes, [])
        self.assertTrue(result["wouldChange"])
        for flag in ("changed", "applied", "verified", "isMember"):
            self.assertFalse(result[flag], flag)
        self.assertEqual([c[0] for c in self.dav.calls], ["PROPFIND", "REPORT", "REPORT", "GET"])
        self.assertEqual(self.dav.calls[0][3]["Depth"], "1")

    def test_apply_uses_fresh_etag_and_preserves_every_other_byte(self):
        self.dav.before = group_card(members=(OTHER, "fresh-member"))
        result = self.execute(apply=True)
        self.assertEqual(len(self.dav.writes), 1)
        method, url, body, headers = self.dav.writes[0]
        self.assertEqual((method, url), ("PUT", GROUP_URL))
        self.assertEqual(headers["If-Match"], '"fresh-get-etag"')
        self.assertEqual(headers["Content-Type"], "text/vcard; charset=utf-8")
        self.assertEqual(body, added_card(self.dav.before))
        self.assertEqual([c[0] for c in self.dav.calls][-3:], ["GET", "PUT", "GET"])
        for flag in ("changed", "applied", "verified", "isMember", "wouldChange"):
            self.assertTrue(result[flag], flag)
        self.assertEqual(result["group"]["memberCount"], 3)
        self.assertIn("previousGroups", result)
        self.assertNotIn("currentGroups", result)

    def test_remove_writes_only_target_member_and_verifies(self):
        self.dav.before = group_card(members=(OTHER, UID, UID))
        result = self.execute("remove", apply=True)
        self.assertEqual(self.dav.saved, group_card(members=(OTHER,)))
        self.assertTrue(result["verified"])
        self.assertFalse(result["isMember"])
        self.assertEqual(len(self.dav.writes), 1)

    def test_preview_remove_does_not_write(self):
        self.dav.before = group_card(members=(OTHER, UID))
        result = self.execute("remove")
        self.assertTrue(result["wouldChange"])
        self.assertFalse(result["applied"])
        self.assertEqual(self.dav.writes, [])

    def test_idempotent_add_and_remove_use_fresh_state_without_etag(self):
        for action, members in (("add", (OTHER, UID)), ("remove", (OTHER,))):
            for apply in (False, True):
                with self.subTest(action=action, apply=apply):
                    dav = FakeDav(group_card(members=members))
                    dav.etag_headers = {}
                    result = m.GroupService(USERNAME, dav).execute(action, "Paperwork", EMAIL, apply=apply)
                    self.assertFalse(result["wouldChange"])
                    self.assertFalse(result["changed"])
                    self.assertFalse(result["applied"])
                    self.assertTrue(result["verified"])
                    self.assertEqual(result["isMember"], action == "add")
                    self.assertEqual(dav.writes, [])
                    self.assertEqual(dav.get_count, 1)

    def test_missing_or_weak_or_invalid_etag_refuses_write(self):
        for value in (None, 'W/"weak"', "unquoted", '""', '"bad\r\nvalue"', 123):
            with self.subTest(etag=value):
                self.dav.etag_headers = {} if value is None else {"ETag": value}
                with self.assertRaisesRegex(m.ContactGroupsError, "strong ETag"):
                    self.execute(apply=True)
                self.assertEqual(self.dav.writes, [])
                self.dav.get_count = 0

    def test_conflict_from_http_transport_is_not_retried(self):
        self.dav.put_result = m.ContactGroupsError("CardDAV conflict (412): group changed; re-read before retrying.")
        with self.assertRaisesRegex(m.ContactGroupsError, r"conflict \(412\)"):
            self.execute(apply=True)
        self.assertEqual(len(self.dav.writes), 1)
        self.assertEqual(self.dav.get_count, 1)

    def test_failed_put_statuses_do_not_retry_or_claim_verification(self):
        for status in (201, 302, 401, 403, 412, 500):
            with self.subTest(status=status):
                dav = FakeDav()
                dav.put_result = (status, {}, SERVER_TEXT)
                with self.assertRaisesRegex(m.ContactGroupsError, "Unexpected write response") as caught:
                    m.GroupService(USERNAME, dav).execute("add", "Paperwork", EMAIL, apply=True)
                self.assertIn(str(status), str(caught.exception))
                self.assertNotIn(SERVER_TEXT, str(caught.exception))
                self.assertEqual(len(dav.writes), 1)
                self.assertEqual(dav.get_count, 1)

    def test_uncertain_write_reports_uncertainty_without_leaking_or_retrying(self):
        self.dav.put_result = m.ContactGroupsError(SERVER_TEXT + SECRET)
        with self.assertRaisesRegex(m.ContactGroupsError, "outcome is uncertain") as caught:
            self.execute(apply=True)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertNotIn(SERVER_TEXT, str(caught.exception))
        self.assertEqual(len(self.dav.writes), 1)
        self.assertEqual(self.dav.get_count, 1)

    def test_access_denied_write_is_not_mislabeled_uncertain(self):
        self.dav.put_result = m.ContactGroupsError("CardDAV access denied (403); check the app password's Contacts access.")
        with self.assertRaisesRegex(m.ContactGroupsError, "access denied"):
            self.execute(apply=True)
        self.assertEqual(len(self.dav.writes), 1)
        self.assertEqual(self.dav.get_count, 1)

    def test_readback_failures_report_written_but_not_verified(self):
        good = added_card(group_card())
        bad_cards = [
            group_card(), good.replace("UID:group-uid", "UID:other-group"),
            good.replace("X-ADDRESSBOOKSERVER-KIND:group", "X-ADDRESSBOOKSERVER-KIND:individual"),
            good.replace("urn:uuid:" + OTHER, "urn:uuid:changed-other"),
            good.replace("NOTE:first part", "NOTE:changed"), "not a vCard " + SERVER_TEXT,
        ]
        cases = [(200, {}, card) for card in bad_cards] + [
            (503, {}, SERVER_TEXT), m.ContactGroupsError(SERVER_TEXT + SECRET),
        ]
        for response in cases:
            with self.subTest(response=response):
                dav = FakeDav()
                dav.verify_result = response
                with self.assertRaisesRegex(m.ContactGroupsError, "was written, but verification failed") as caught:
                    m.GroupService(USERNAME, dav).execute("add", "Paperwork", EMAIL, apply=True)
                self.assertNotIn(SERVER_TEXT, str(caught.exception))
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertEqual(len(dav.writes), 1)
                self.assertEqual(dav.get_count, 2)

    def test_verification_rejects_lost_unrelated_member_parameters(self):
        self.dav.before = group_card().replace("X-ADDRESSBOOKSERVER-MEMBER:", "X-ADDRESSBOOKSERVER-MEMBER;X-LABEL=keep:")
        self.dav.verify_result = (200, {}, added_card(self.dav.before).replace(";X-LABEL=keep", ""))
        with self.assertRaisesRegex(m.ContactGroupsError, "was written, but verification failed"):
            self.execute(apply=True)
        self.assertEqual(len(self.dav.writes), 1)

    def test_verification_allows_rev_and_folding_changes(self):
        saved = added_card(group_card()).replace("REV:20260909T120000Z", "REV:20260909T130000Z")
        saved = saved.replace("NOTE:first part\r\n second part", "NOTE:first partsecond part")
        self.dav.verify_result = (200, {}, saved)
        self.assertTrue(self.execute(apply=True)["verified"])

    def test_fresh_get_failures_and_changed_identity_prevent_write(self):
        for before, status in ((group_card(), 404), (contact_card(), 200),
                               (group_card(uid="new-uid"), 200), ("bad card", 200)):
            with self.subTest(before=before, status=status):
                dav = FakeDav(before)
                dav.fresh_status = status
                with self.assertRaises(m.ContactGroupsError):
                    m.GroupService(USERNAME, dav).execute("add", "Paperwork", EMAIL, apply=True)
                self.assertEqual(dav.writes, [])

    def test_duplicate_group_names_and_uids_are_refused(self):
        for uid in ("different-uid", "group-uid"):
            with self.subTest(uid=uid):
                self.dav.groups[BOOK] = [(GROUP_URL, group_card()), (BOOK + "duplicate.vcf", group_card(uid=uid))]
                for selector in (["Paperwork", "group-uid"] if uid == "group-uid" else ["Paperwork"]):
                    with self.assertRaisesRegex(m.ContactGroupsError, "Group missing or ambiguous"):
                        self.service.execute("add", selector, EMAIL, apply=True)
                self.assertEqual(self.dav.writes, [])

    def test_duplicate_contacts_are_refused_for_email_and_uid(self):
        self.dav.contacts[BOOK].append((BOOK + "duplicate.vcf", contact_card()))
        for selector in ({"email": EMAIL}, {"contact_uid": UID}):
            with self.subTest(selector=selector):
                with self.assertRaisesRegex(m.ContactGroupsError, "Contact missing or ambiguous"):
                    self.service.execute("add", "Paperwork", apply=True, **selector)
                self.assertEqual(self.dav.writes, [])

    def test_cross_book_membership_refused(self):
        self.dav.books.append(SECOND_BOOK)
        self.dav.contacts = {SECOND_BOOK: [(SECOND_BOOK + "contact.vcf", contact_card())]}
        with self.assertRaisesRegex(m.ContactGroupsError, "different address books"):
            self.execute(apply=True)
        self.assertEqual(self.dav.writes, [])
        self.assertEqual(self.dav.get_count, 0)

    def test_email_matching_is_case_insensitive_exact_and_not_fuzzy(self):
        self.dav.contacts[BOOK] = [
            (CONTACT_URL, contact_card(email=EMAIL.upper())),
            (BOOK + "prefix.vcf", contact_card("prefix", "x" + EMAIL)),
            (BOOK + "suffix.vcf", contact_card("suffix", EMAIL + ".evil")),
            (BOOK + "display.vcf", contact_card("display", "Person <" + EMAIL + ">")),
        ]
        result = self.execute()
        self.assertEqual(result["contact"]["uid"], UID)
        self.assertTrue(result["wouldChange"])
        report = [call for call in self.dav.calls if call[0] == "REPORT"][-1]
        match = ET.fromstring(report[2]).find(".//{" + m.CARD + "}text-match")
        self.assertEqual(match.attrib["match-type"], "equals")
        self.assertEqual(match.text, EMAIL)

    def test_fuzzy_only_email_and_inexact_uid_do_not_match(self):
        for selector, card in (({"email": EMAIL}, contact_card(email="x" + EMAIL)),
                               ({"contact_uid": UID}, contact_card(uid=UID + "x")),
                               ({"contact_uid": UID, "email": EMAIL}, contact_card(email="wrong@example.test"))):
            with self.subTest(selector=selector):
                self.dav.contacts[BOOK] = [(CONTACT_URL, card)]
                with self.assertRaisesRegex(m.ContactGroupsError, "Contact missing or ambiguous"):
                    self.service.execute("add", "Paperwork", apply=True, **selector)
                self.assertEqual(self.dav.writes, [])

    def test_exact_uid_selector_works_without_email(self):
        result = self.service.execute("add", "group-uid", contact_uid=UID)
        self.assertEqual(result["contact"]["uid"], UID)
        self.assertTrue(result["wouldChange"])

    def test_list_and_get_are_read_only(self):
        result = self.service.execute("list")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["groups"][0]["uid"], "group-uid")
        result = self.execute("get")
        self.assertFalse(result["isMember"])
        self.assertEqual(self.dav.writes, [])
        self.assertEqual(self.dav.get_count, 0)

    def test_folded_member_removal_preserves_unrelated_raw_properties(self):
        folded = "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:" + UID[:20] + "\r\n " + UID[20:] + "\r\n"
        self.dav.before = group_card().replace("END:VCARD", folded + "END:VCARD")
        self.assertTrue(self.execute("remove", apply=True)["verified"])
        self.assertEqual(self.dav.saved, group_card())

    def test_long_uid_member_is_folded_at_75_utf8_bytes(self):
        uid = "long-" + "a" * 160
        self.dav.contacts[BOOK] = [(CONTACT_URL, contact_card(uid=uid))]
        result = self.service.execute("add", "Paperwork", contact_uid=uid, apply=True)
        self.assertTrue(result["verified"])
        self.assertIn("urn:uuid:" + uid, m.parse_card(self.dav.saved)["members"])
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in self.dav.saved.splitlines()))
        self.assertEqual(self.dav.saved.split("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:" + uid[:5])[0],
                         group_card().split("END:VCARD")[0])


class XmlAndUrlSafetyTests(unittest.TestCase):
    def test_unsafe_discovery_hrefs_fail_before_any_followup_request(self):
        hrefs = [
            "https://evil.example/dav/addressbooks/user/test/book/",
            "//evil.example/dav/addressbooks/user/test/book/",
            "http://carddav.fastmail.com/dav/addressbooks/user/test/book/",
            "https://user:password@carddav.fastmail.com/dav/addressbooks/user/test/book/",
            "https://carddav.fastmail.com.evil.example/dav/addressbooks/user/test/book/",
            "/unrelated/path/", BOOK + "?query=1", BOOK + "#fragment",
            BOOK + "%2e%2e/secret", BOOK + "%5csecret", BOOK + "%0asecret",
        ]
        for href in hrefs:
            with self.subTest(href=href):
                transport = mock.Mock(return_value=(207, {}, multistatus([(href, None)])))
                with self.assertRaisesRegex(m.ContactGroupsError, "unexpected CardDAV resource URL"):
                    m.GroupService(USERNAME, transport).execute("list")
                self.assertEqual(transport.call_count, 1)

    def test_report_resource_outside_selected_book_is_refused(self):
        for href in (SECOND_BOOK + "group.vcf", BOOK.rstrip("/") + "-evil/group.vcf"):
            with self.subTest(href=href):
                dav = FakeDav()
                dav.groups[BOOK] = [(href, group_card())]
                with self.assertRaisesRegex(m.ContactGroupsError, "outside its address book"):
                    m.GroupService(USERNAME, dav).execute("add", "Paperwork", EMAIL, apply=True)
                self.assertEqual(dav.writes, [])

    def test_entities_malformed_and_incomplete_xml_are_refused(self):
        valid = multistatus([(BOOK, None)])
        root = ET.fromstring(valid)
        root.find(".//{" + m.DAV + "}href").text = None
        missing_href = ET.tostring(root, encoding="unicode")
        cases = [
            '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///do-not-read">]>' + valid,
            '<!ENTITY secret "private">' + valid,
            '<multistatus', '<html>' + SERVER_TEXT + '</html>',
            valid.replace("200 OK", "404 Not Found"), missing_href,
            '<d:multistatus xmlns:d="DAV:"><d:response><d:href>' + BOOK + '</d:href></d:response></d:multistatus>',
        ]
        for text in cases:
            with self.subTest(text=text):
                transport = mock.Mock(return_value=(207, {}, text))
                with self.assertRaises(m.ContactGroupsError) as caught:
                    m.GroupService(USERNAME, transport).execute("list")
                self.assertNotIn(SERVER_TEXT, str(caught.exception))
                self.assertEqual(transport.call_count, 1)

    def test_report_missing_vcard_is_refused(self):
        transport = mock.Mock(side_effect=[
            (207, {}, multistatus([(BOOK, None)])),
            (207, {}, multistatus([(GROUP_URL, None)])),
        ])
        with self.assertRaisesRegex(m.ContactGroupsError, "omitted vCard data"):
            m.GroupService(USERNAME, transport).execute("list")

    def test_non_multistatus_http_responses_are_not_parsed(self):
        for status in (200, 302, 500):
            with self.subTest(status=status):
                transport = mock.Mock(return_value=(status, {"Location": "https://evil.example"}, SECRET + SERVER_TEXT))
                with self.assertRaisesRegex(m.ContactGroupsError, "Unexpected CardDAV PROPFIND response") as caught:
                    m.GroupService(USERNAME, transport).execute("list")
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertNotIn(SERVER_TEXT, str(caught.exception))
                self.assertEqual(transport.call_count, 1)


class HttpAndCliTests(unittest.TestCase):
    def setUp(self):
        # Constructing an HTTP client cannot acquire a real network opener in these tests.
        self.patcher = mock.patch.object(m.urllib.request, "build_opener")
        self.build_opener = self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.opener = self.build_opener.return_value

    def client(self):
        return m.HttpDav(USERNAME, SECRET)

    def test_missing_or_invalid_credentials_rejected_before_opener(self):
        for username, password in ((USERNAME, None), (USERNAME, ""), ("", SECRET),
                                   ("user:bad", SECRET), ("user\n", SECRET), ("user\r", SECRET)):
            with self.subTest(username=username, password=password):
                with self.assertRaises(m.ContactGroupsError) as caught:
                    m.HttpDav(username, password)
                self.assertNotIn(SECRET, str(caught.exception))
        self.build_opener.assert_not_called()

    def test_redirect_handler_is_installed_and_refuses_all_redirect_codes(self):
        self.client()
        handler = self.build_opener.call_args.args[0]
        self.assertIsInstance(handler, m.NoRedirect)
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                request = urllib.request.Request(GROUP_URL)
                self.assertIsNone(handler.redirect_request(request, None, status, SERVER_TEXT,
                                                          {"Location": "https://evil.example"}, "https://evil.example"))

    def test_http_errors_are_sanitized_and_never_retried(self):
        client = self.client()
        for status in (301, 302, 307, 308, 401, 403, 412, 500):
            with self.subTest(status=status):
                self.opener.open.reset_mock()
                payload = io.BytesIO((SECRET + SERVER_TEXT).encode())
                self.opener.open.side_effect = urllib.error.HTTPError(
                    "https://evil.example/" + SECRET, status, SERVER_TEXT, {}, payload)
                with self.assertRaises(m.ContactGroupsError) as caught:
                    client("PUT", GROUP_URL, "body", {"If-Match": '"fresh"'})
                self.assertIn(str(status), str(caught.exception))
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertNotIn(SERVER_TEXT, str(caught.exception))
                self.opener.open.assert_called_once()
                self.assertEqual(payload.tell(), 0)

    def test_network_and_decode_errors_are_sanitized(self):
        client = self.client()
        for error in (urllib.error.URLError(SECRET + SERVER_TEXT), TimeoutError(SECRET), OSError(SERVER_TEXT)):
            with self.subTest(error=error):
                self.opener.open.side_effect = error
                with self.assertRaisesRegex(m.ContactGroupsError, "network/encoding error") as caught:
                    client("GET", GROUP_URL)
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertNotIn(SERVER_TEXT, str(caught.exception))
        self.opener.open.side_effect = None
        response = self.opener.open.return_value.__enter__.return_value
        response.read.return_value = b"\xff"
        with self.assertRaisesRegex(m.ContactGroupsError, "network/encoding error"):
            client("GET", GROUP_URL)

    def test_http_rejects_unsafe_url_without_opening(self):
        with self.assertRaises(m.ContactGroupsError):
            self.client()("GET", "https://evil.example/" + SECRET)
        self.opener.open.assert_not_called()

    def test_response_size_limit(self):
        response = self.opener.open.return_value.__enter__.return_value
        response.read.return_value = b"x" * 17
        with mock.patch.object(m, "MAX_BYTES", 16):
            with self.assertRaisesRegex(m.ContactGroupsError, "safety limit"):
                self.client()("GET", GROUP_URL)
        response.read.assert_called_once_with(17)

    def test_http_success_encodes_body_and_preserves_if_match(self):
        response = self.opener.open.return_value.__enter__.return_value
        response.status = 204
        response.headers = {"ETag": '"new"'}
        response.read.return_value = b""
        client = self.client()
        self.assertEqual(client("PUT", GROUP_URL, "FN:René", {"If-Match": '"fresh"'}),
                         (204, {"ETag": '"new"'}, ""))
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.data, "FN:René".encode("utf-8"))
        self.assertEqual(request.get_method(), "PUT")
        self.assertEqual(request.get_header("If-match"), '"fresh"')
        self.assertEqual(request.get_header("Authorization"), client.authorization)
        self.assertEqual(self.opener.open.call_args.kwargs["timeout"], 30)

    def test_cli_missing_username_returns_json_error_without_network(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(m.os.environ, {"FASTMAIL_APP_PASSWORD": SECRET}, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = m.main(["list"])
        self.assertEqual(code, 1)
        self.assertIn("FASTMAIL_USERNAME", json.loads(out.getvalue())["error"])
        self.assertNotIn(SECRET, out.getvalue())
        self.assertEqual(err.getvalue(), "")
        self.build_opener.assert_not_called()

    def test_cli_missing_password_returns_json_error_without_network(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(m.os.environ, {"FASTMAIL_USERNAME": USERNAME}, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = m.main(["list"])
        self.assertEqual(code, 1)
        self.assertIn("FASTMAIL_APP_PASSWORD", json.loads(out.getvalue())["error"])
        self.assertNotIn(USERNAME, out.getvalue())
        self.assertEqual(err.getvalue(), "")
        self.build_opener.assert_not_called()

    def test_cli_rejects_blank_or_control_character_username_without_network(self):
        for username in ["  ", "user@example.com:other", "user@example.com\nother", "\nuser@example.com", "user@example.com\t"]:
            with self.subTest(username=repr(username)):
                out, err = io.StringIO(), io.StringIO()
                with mock.patch.dict(m.os.environ, {"FASTMAIL_USERNAME": username, "FASTMAIL_APP_PASSWORD": SECRET}, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = m.main(["list"])
                self.assertEqual(code, 1)
                self.assertIn("FASTMAIL_USERNAME", json.loads(out.getvalue())["error"])
                self.assertNotIn("user@example.com", out.getvalue())
                self.assertEqual(err.getvalue(), "")
                self.build_opener.assert_not_called()

    def test_cli_unexpected_exception_does_not_leak_password_or_server_text(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(m.os.environ, {"FASTMAIL_USERNAME": USERNAME, "FASTMAIL_APP_PASSWORD": SECRET}, clear=True), \
                mock.patch.object(m.GroupService, "execute", side_effect=RuntimeError(SECRET + SERVER_TEXT)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = m.main(["add", "--group", "Paperwork", "--email", EMAIL, "--apply"])
        self.assertEqual(code, 1)
        self.assertIn("no automatic retry", json.loads(out.getvalue())["error"])
        self.assertNotIn(SECRET, out.getvalue() + err.getvalue())
        self.assertNotIn(SERVER_TEXT, out.getvalue() + err.getvalue())
        self.assertEqual(err.getvalue(), "")
        self.opener.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
