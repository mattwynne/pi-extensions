import importlib.util
import pathlib
import unittest

SPEC = importlib.util.spec_from_file_location("contact_groups", pathlib.Path(__file__).parents[1] / "contact-groups.py")
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

UID = "12345678-1234-1234-1234-123456789abc"
OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

def group(version="3.0", newline="\r\n"):
    return newline.join([
        "BEGIN:VCARD", "VERSION:" + version, "UID:group-uid", "FN:Paperwork",
        ("KIND" if version == "4.0" else "X-ADDRESSBOOKSERVER-KIND") + ":group",
        "X-KEEP;LABEL=\"a:b\":untouched", "NOTE:folded first", " second",
        ("MEMBER" if version == "4.0" else "X-ADDRESSBOOKSERVER-MEMBER") + ":urn:uuid:" + OTHER,
        "END:VCARD", "",
    ])

class VCardTests(unittest.TestCase):
    def test_add_preserves_every_existing_byte(self):
        before = group()
        after = m.change_membership(before, UID, "add")
        added = "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:" + UID + "\r\n"
        self.assertEqual(after.replace(added, ""), before)
        self.assertIn("urn:uuid:" + UID, m.parse_card(after)["members"])

    def test_uuid_uri_scheme_and_hex_case_are_equivalent(self):
        before = group().replace("urn:uuid:" + OTHER, "URN:UUID:" + OTHER.upper())
        self.assertEqual(m.change_membership(before, OTHER, "add"), before)
        self.assertNotIn("URN:UUID:", m.change_membership(before, OTHER, "remove"))

    def test_add_is_idempotent(self):
        after = m.change_membership(group(), UID, "add")
        self.assertEqual(m.change_membership(after, UID, "add"), after)

    def test_remove_preserves_other_members_and_fields(self):
        before = group()
        after = m.change_membership(before, OTHER, "remove")
        self.assertNotIn("urn:uuid:" + OTHER, after)
        self.assertIn('X-KEEP;LABEL="a:b":untouched', after)
        self.assertIn("NOTE:folded first\r\n second", after)
        self.assertEqual(m.change_membership(after, UID, "remove"), after)

    def test_v4_and_lf(self):
        after = m.change_membership(group("4.0", "\n"), UID, "add")
        self.assertIn("\nMEMBER:urn:uuid:" + UID + "\n", after)
        self.assertNotIn("\r", after)

    def test_rejects_contact_as_group(self):
        with self.assertRaises(m.ContactGroupsError):
            m.change_membership("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:A\r\nEND:VCARD\r\n", UID, "add")

    def test_rejects_uid_injection(self):
        with self.assertRaises(m.ContactGroupsError):
            m.change_membership(group(), "bad\r\nFN:injected", "add")

if __name__ == "__main__":
    unittest.main()
