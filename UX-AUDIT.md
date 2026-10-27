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

## Deliberately not changed (candidates for a later pass)

- Two implementations of the weekly timetable (staff `renderSchedule`, student `renderStudentTimetable`).
- Three copies of CSV/PDF export code (older `exportReport`, `exportComplianceReport`, and the newer shared `csvDownload`/`printReport`). Moving the old two onto the shared ones would remove about 150 lines and make every export behave the same.
- Two profile screens (staff, student).
- The Records tab (catalog) and Reports & Analytics > Attendance Records overlap. They answer different questions today (browse by course vs charts and export), so merging needs your call.
- Per-student percentage (`STUDENTS.pct`) and record-based percentage use the same credit rules but are computed in different places. Worth unifying.
- Support Tickets is called "Report an Issue" for students and lecturers, "Support Tickets" for staff. Same screen, two names.
