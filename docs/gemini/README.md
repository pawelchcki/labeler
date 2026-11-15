# Enable Labeler in Gemini

Prepared bundle: `dist/labeler-release.aab`, package `net.chcki.labeler`, version code 1. Local upload key: ignored `.signing/`; back it up securely and keep it out of Git. A Play-delivered app may use a different app-signing certificate. The phone has the debug-signed `net.chcki.labeler` build; Android Bluetooth printing was confirmed on 2026-11-15. Preserve the original upload key. Release binaries are generated locally and excluded from the source repository; rebuild the release bundle before preparing an update.

Console assets: `icon-512.png` and `connected-app.json` in this directory. The JSON is copy/paste metadata, not a Console import format. Public Privacy Policy and Terms of Service URLs still need to be supplied; null values are intentional. No claim is made that the app is registered or submitted.

## Early Access approval comes first

Google's AppFunctions overview, checked 2026-11-13, says Gemini integration is in private preview and only selected apps and agents can access the entire pipeline. Register interest through the AppFunctions Early Access Program form: https://forms.gle/GN5ybjQFhzHRCguM7 . Registration does not automatically grant access; Google emails selected apps or announces public availability. Use app name Labeler and package net.chcki.labeler when applying.

An Android 16+ device, indexed AppFunctions, the caller's EXECUTE_APP_FUNCTIONS permission, a Play developer account, and an uploaded bundle are separate prerequisites; none establishes that Gemini can invoke this app. Until Google confirms the required access, the actions can be locally implemented without any available assistant that can invoke them. Console submission is a later setup step and is not an access workaround. A console 404 alone does not prove its cause.

Source: https://developer.android.com/ai/appfunctions#frequently-asked-questions-faqs .

## Registration after access is available

1. Open https://play.google.com/console with the developer account (the connected.google.com shortcut returned 404 during setup). An account owner/admin must review and accept any Connected Apps terms themselves.
2. Create a Play app if it does not exist. Configure its default store listing with an icon and supported languages/countries.
3. Create a Connected app named Labeler. Choose a suitable category and **Android MCP**, then link the correct Play app. Category, connection type and Play app link cannot be changed later.
4. Fill and **save App details before uploading**: icon, description, three capabilities, three example prompts, and public policy/terms URLs.
5. In the linked Play app, create an Internal testing draft release and upload the signed AAB. Check **two detected AppFunctions** and the language/country targeting. Resolve validation errors before proceeding.
6. Review **Submit connected app and continue** before submitting. This can notify release managers by email. Leave the Play release as **Draft** for local preview testing; a public release is not required.
7. Verify the connected version is Available to testers. Add your personal `@gmail.com` Gemini account under Manage testers. Submission can take about 20 minutes to propagate; tester changes can take 10 minutes.
8. Keep the sideloaded app's version code equal to the submitted bundle (currently 1). On the phone, select a printer and allow Nearby devices. In Gemini type `@Labeler`, or open Settings & help → Connected apps.

The connected phone is Android 16 / API 36. Its AppFunctions service indexed both actions in the earlier dev.pawel.actionprinter build, and the Google app held EXECUTE_APP_FUNCTIONS permission. The renamed net.chcki.labeler build is installed and Android Bluetooth printing works with the updated transport. No successful Gemini invocation is established for either package.

Official workflow: https://developer.android.com/ai/appfunctions/create-manage-connected-apps (checked 2026-11-12).

Rebuild: set the JDK/Android/Rust environment described in the project README; run `python3 scripts/init-upload-key.py` only for first-time key creation, then `./gradlew bundleRelease`. Rust uses 16 KB ELF/RELRO alignment flags with NDK r27.
