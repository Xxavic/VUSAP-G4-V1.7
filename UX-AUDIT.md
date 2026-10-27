# UX audit and consolidation (Oct 2026)

Method: every screen for all four roles was rendered and its links mapped
(who can reach what, from where), then each suspected overlap was checked in
the code before being listed.

## What was wrong, and what patch 0011 does about it

| # | Finding (verified in code) | Change |
|---|---|---|
| 1 | Messaging was five screens (Inbox, Announcements, Send, Outbox, and templates) each reached from a different place. Posting an announcement also pushed a notification, so recipients saw it twice. | Inbox, Announcements, Send and Sent now share one tab strip (students: Inbox, Announcements). Dashboards show one "Messages" entry. Duplicate delivery is left as is: it is an alert plus an archive. |
| 2 | Timetable and Calendar were separate tabs/cards for the same question ("when?"). Student and lecturer nav had an extra tab. | One "Schedule" tab with a Timetable / Calendar switch. Registrar and Administrator get the same switch on Schedules. |
| 3 | Two fraud screens: Fraud Center (list) and Device Fraud Patterns (buried in the analytics hub). | One Fraud Center with Flags / By device. |
| 4 | Two lecturer screens in different places: Lecturer Compliance and Lecturer Punctuality. | One "Lecturers" section with Delivery rate / Punctuality tabs. |
| 5 | The Compliance screen showed "Faculty Attendance" and "Programme Analytics" averaged a different way (mean of per-student percentages) from Cohort Comparison (weighted over records), so the two could disagree. | Removed from Compliance, replaced by a link to Cohort Comparison, so there is one definition. |
| 6 | The Analytics hub was ten flat items. | Grouped: Students, Patterns, Lecturers. |
| 7 | Registrar dashboard: 13 flat cards, alerts buried below a long record list. | Grouped: Needs your attention (first), Reports, Manage. |
| 8 | Administrator dashboard: 13 flat modules; Faculties & Programmes and Role Assignments reachable only through stat tiles. | Grouped: People & structure, Attendance rules, Communication, System. Both missing modules added. |
| 9 | Student and lecturer dashboards repeated what the bottom nav and header already offer (Timetable, Attendance, Profile). | Removed the repeats. |
| 10 | "Reports & Export" screen: routed but nothing linked to it (dead code). Its export lives on in Attendance Records. | Removed. |
| 11 | Administrator's "Academic Year Archives" tile did nothing ("Unknown module"). | Fixed. |
| 12 | "Register" meant two things (people directory, and attendance register). | Registrar and Administrator now say "People". |
| 13 | Semester dates live in System Settings, holidays in the Calendar editor, with no pointer between them. | Calendar editor links to System Settings. |

## Second pass (patch 0012)

- **Exports:** `exportReport` and `exportComplianceReport` now use the shared `csvDownload` / `printReport`, about 280 lines removed. Side effects you will notice: CSV cells with quotes or commas are now escaped correctly (the old builder broke on them), and the PDF no longer colours the status/rate text.
- **Percentages:** the live student loader now computes `STUDENTS.pct` and the trend with `weightedAttendancePct`, the same function every record-based figure uses. Results are identical on test data. Note the two figures can still differ for a student because `STUDENTS.pct` covers all their attendance rows while screens built from `RECORDS` cover only the records loaded for that screen.
- **Timetable:** the student timetable now has the same search and day filter as the staff schedule (one shared `scheduleFilterBar`). The two views stay separate on purpose: staff can edit, group by mode and filter by department; students see a read-only list of their own courses.
- **Profiles:** one `profileScreen` shell for all roles. Students' page title changes from "Profile & Settings" to "Profile", and "Preferences" to "Settings", to match staff.
- **Support:** the screen, dashboard tiles and the admin module are all called "Support". The button inside the screen still says "Report an Issue" because that is the action.
- **Records vs charts (your call: keep both, link them):** the Reports tile and screen are now "Attendance Charts" (they were "Attendance Records" on the tile and "Student Attendance" on the screen). The Registrar's Records tab has a "Charts & export" link, and the charts screen has a "Browse by course" link back. Administrators have no analytics screens, so they see no charts link.

## Still open

Nothing from the first audit is left. Not covered: the optional ideas still parked (guardian notifications, grades feed).
