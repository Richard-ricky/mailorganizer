# Mail organiser

Search your email by sender, organisation, date and time, and let it sort new mail into group folders for you. Works with any mailbox that supports IMAP.

## Run it

1. Install Node.js 18 or newer from nodejs.org.
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000 and sign in.

## Reading email

- **Formatted view:** newsletters and designed emails appear as the sender intended, in a locked-down frame. Scripts, forms, embedded pages and tracking pixels are removed, and the frame itself cannot run code or load anything from the internet.
- **Images are blocked by default.** Senders use remote images to see that you opened an email. A banner shows how many were blocked, and "Load images" shows them for that email only. Pictures embedded inside the email itself (such as logos) always show.
- **Text view:** switch to the plain-text version at any time. Long tracking links become short labels such as `e2.udemymail.com ↗`, and they still open the real address in a new tab.
- **Sender header:** name, address, recipient and date, with the sender's initials.
- **Attachments:** listed with name and size. Selecting one downloads it with its real name. Attachments are always sent as plain downloads and are never opened inside the app, and files over 25 MB are not offered.

## Priority: it works out what matters

The **Priority** view is the default. It sorts your mail into **Needs you**, **Worth a look** and **Low priority**, and shows a short reason under each email ("You email them (3×) · Sent directly to you · Ongoing conversation").

It learns, privately on your computer, from:
- **Your Sent folder:** people you write to rank higher. This works from the first minute, so there is nothing to set up or train.
- **What you open:** senders whose mail you read rank higher over time.
- **What you clear:** using "Clear noise" tells it you don't want those senders pushed to the top.
- **How each message looks:** newsletter and mailing-list headers, "no-reply" senders, promotional wording, mass emails, and mail sent directly to you. Deadline wording ("urgent", "invoice", "interview") gives a boost.
- **Your groups:** mail from your own groups gets a small lift.

You stay in control. Open any email and choose **Always important** or **Treat as noise** for that sender. Those choices override everything else. Nothing is deleted, and nothing leaves your computer.

## Automatic filing

1. Create a group (for example "Lecturers" with members `ama@mail.com, @knust.edu.gh`).
2. Tick **File new mail into group folders** in the Automatic filing section.

From then on, mail from your groups is filed into `Groups/<name>` folders in your real mailbox, checked every minute. It starts from the moment you turn it on, so your old mail is not touched (use "File into group folders" in the By group view for that).

Each group has two options:
- **Take filed mail out of my inbox:** moves the mail instead of copying it. Use "Look in" to read a group's folder.
- **Mark filed mail as read:** useful for newsletters and notices you only need to keep.

Good to know:
- It runs while this app is running and you are signed in. Mail that arrives while the app is closed is filed the next time you sign in.
- While it is on, you stay signed in for up to 7 days. Signing out turns the checking off until you sign in again.
- A "Check now" button, a log of recent filing, and optional desktop alerts show you what it did.
- Copying is the default, so nothing leaves your inbox unless you choose that for a group. Nothing is ever deleted.

## Everyday use

- **Find by sender:** type names, full addresses or `@company.com` in the From box. Separate several with commas. A group name searches all of its members.
- **Find new mail:** tick "New (unread) only", use the quick ranges (last hour, today, last 7 days), or set an exact date and time range.
- **Look in:** search your inbox or any group folder.
- **Organise:** switch between Newest first, By group, By person and By organisation. Unread counts show next to each group.
- **Suggested groups:** appear above your results when a sender or organisation shows up often.
- **Saved searches:** save filters you use often and run them in one click. Quick ranges such as "Last 24 hours" are recalculated each time.
- **Mark as read:** opening an email marks it read (you can turn this off), or use "Mark read" on a whole group.
- **Export CSV:** download the emails on screen for a spreadsheet.
- **Shortcuts:** `/` jumps to the From box, `r` refreshes, `Esc` closes an email.

## Why it is fast

- One mailbox connection stays open while you work instead of signing in for every search.
- A group of many people is searched in a single request.
- Automatic filing looks only at mail that arrived since the last check.
- Priority scoring runs on your computer in a fraction of a second, with no extra requests.
- Only the newest 100 emails load (Load more goes up to 500), and opened emails are cached.
- Starting a new search cancels the one still running.

## Sign-in notes

- **Gmail:** turn on 2-step verification, then create an app password at myaccount.google.com/apppasswords. Use that instead of your normal password. Server: imap.gmail.com, port 993. Group folders appear as labels.
- **Yahoo:** also needs an app password (Account security settings).
- **Outlook / Microsoft 365:** many accounts have password sign-in for IMAP turned off. If sign-in fails, the account may need OAuth, which this version does not include.
- Port 993 uses SSL. Other ports (such as 143) connect over STARTTLS when the server offers it.

## Privacy and limits

- The server only listens on your own computer (127.0.0.1).
- Your password is held in memory while the app runs and is never saved.
- Groups, saved searches, the record of filed emails and what Priority has learned (counts per sender) are saved in the `data/` folder. Groups from earlier versions carry over.
- Email HTML is cleaned on the server before it is shown, and displayed in a sandboxed frame that blocks everything external.
- The app reads email, marks it read, and copies or moves it into `Groups/` folders. It never deletes anything and does not send.
- If one email matches several groups, it is copied into every group that copies, and moved into only the first group that moves.
- Unread counts cover up to 30 groups, and a group search uses up to 40 senders or domains at a time.