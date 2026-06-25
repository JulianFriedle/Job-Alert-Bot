// ── Shared i18n (German / English) ────────────────────────────────────────────
// Loaded BEFORE setup.js and app.js so both can use the same translations.
// Backend-provided strings (settings fields, setup wizard) stay German in the
// API; they are translated on the client by their stable key / id, with the
// German text used as the fallback when no English override exists.

const qsa = (sel, el = document) => [...el.querySelectorAll(sel)];

const I18N = {
  de: {
    'tab.jobs': 'Jobs', 'tab.stats': 'Statistik', 'tab.sources': 'Quellen',
    'tab.profile': 'Profil', 'tab.prompts': 'Prompts', 'tab.run': 'Lauf', 'tab.settings': 'Einstellungen',
    'tab.clients': 'Klienten',
    'btn.startRun': '▶ Lauf starten', 'btn.save': 'Speichern', 'btn.reset': 'Zurücksetzen',

    // ── Auth / clients (multi-tenant) ──
    'auth.title': 'Anmeldung', 'auth.subtitle': 'Bitte mit den Betreiber-Zugangsdaten anmelden.',
    'auth.user': 'Benutzer', 'auth.password': 'Passwort', 'auth.login': 'Anmelden', 'auth.logout': 'Abmelden',
    'client.active': 'Klient', 'client.activeBadge': 'aktiv',
    'clients.title': 'Klienten', 'clients.add': '+ Klient', 'clients.inactive': 'inaktiv',
    'clients.intro': 'Lege Klienten an und pflege ihre Telegram-Chat-ID. Lebenslauf, Quellen, Filter und Prompts werden je Klient über die anderen Tabs gepflegt — wähle dazu oben rechts den aktiven Klienten.',
    'clients.select': 'auswählen', 'clients.chatId': 'Telegram Chat-ID',
    'clients.enabled': 'im Lauf aktiv', 'clients.telegram': 'Telegram', 'clients.expiry': 'Ablauf-Hinweise',
    'clients.minScore': 'Min. Relevanz-Score (leer = global)', 'clients.tgTest': 'Telegram-Test',
    'clients.editContent': 'Inhalte dieses Klienten bearbeiten',
    'clients.delete': 'Löschen', 'clients.saved': 'Klient gespeichert', 'clients.created': 'Klient angelegt',
    'clients.deleted': 'Klient gelöscht', 'clients.tgOk': 'Test-Nachricht gesendet ✓',
    'clients.namePrompt': 'Name des neuen Klienten:',
    'clients.delConfirm': 'Klient „{name}" mit allen Jobs wirklich löschen?',

    'jobs.searchPh': 'Suche nach Titel, Firma, Ort…', 'jobs.allSources': 'Alle Quellen',
    'jobs.allStatuses': 'Alle Status', 'jobs.empty': 'Keine Jobs gefunden.',
    'jobs.of': 'von', 'jobs.statusPlaceholder': 'Status…',
    'jobs.sortRelevance': 'Relevanz', 'jobs.sortOldest': 'Älteste zuerst', 'jobs.sortNewest': 'Neueste zuerst',
    'status.none': 'Ohne Bewerbung', 'status.applied': 'Beworben', 'status.interview': 'Interview',
    'status.offer': 'Angebot', 'status.rejected': 'Abgelehnt',
    'job.coverTitle': 'Anschreiben erstellen', 'job.openTitle': 'Öffnen',
    'job.ignoreTitle': 'Als irrelevant ausblenden', 'job.statusTitle': 'Bewerbungsstatus',
    'job.confirmIgnore': 'Diesen Job als irrelevant ausblenden?',
    'stat.relevantJobs': 'Relevante Jobs', 'stat.topMatch': 'Top-Match (≥8)',
    'stat.avgScore': 'Ø Score', 'stat.applied': 'Beworben',

    'toast.loadError': 'Fehler beim Laden: ', 'toast.statusReset': 'Status zurückgesetzt',
    'toast.hidden': 'Ausgeblendet', 'toast.error': 'Fehler: ',
    'toast.copied': 'In Zwischenablage kopiert', 'toast.copiedShort': 'Kopiert',

    'cover.title': 'Anschreiben', 'cover.loading': 'Anschreiben wird erstellt…',
    'cover.regen': '↻ Neu generieren', 'cover.copy': '📋 Kopieren', 'cover.close': 'Schließen',
    'cover.generate': '✎ Anschreiben erstellen',
    'cover.notesLabel': 'Zusätzliche Hinweise für dieses Anschreiben (optional)',
    'cover.notesPlaceholder': 'z. B. besondere Motivation, relevante Projekte, Gehaltsvorstellung …',
    'cover.applied': '✓ Als beworben markieren', 'cover.appliedDone': '✓ Beworben',

    'stats.activity': 'Bewerbungs-Aktivität', 'stats.less': 'weniger', 'stats.more': 'mehr',
    'stats.topCompanies': 'Meiste Bewerbungen (Firmen)', 'stats.topSources': 'Top-Quellen (relevante Jobs)',
    'stats.runHistory': 'Lauf-Verlauf', 'stats.runHistorySub': 'gefunden vs. relevant pro Lauf',
    'stats.runOverview': 'Lauf-Übersicht', 'stats.error': 'Statistik-Fehler: ',
    'stats.cardTotal': 'Jobs gesamt', 'stats.cardRelevant': 'Relevant',
    'stats.cardNotified': 'Benachrichtigt', 'stats.cardApplied': 'Beworben',
    'stats.noData': 'Noch keine Daten.', 'stats.noApplications': 'Noch keine Bewerbungen.',
    'stats.legendFound': 'Gefunden', 'stats.legendRelevant': 'Relevant',
    'stats.inLastYear': ' im letzten Jahr', 'stats.lastRun': 'letzter Lauf · ', 'stats.total': 'Gesamt',
    'stats.allTimeSub': 'Gesamt (alle Zeit) · per-Lauf-Spalten erscheinen nach dem nächsten Lauf',
    'stats.headers': ['Unternehmen', 'Gefunden', 'Laut Web', 'Neu(DB)', 'Geblockt', 'Analysiert', 'Neu Rel.', 'Ges. Rel.', 'Notified'],
    'stats.headersFallback': ['Unternehmen', 'Gefunden', 'Analysiert', 'Ges. Rel.', 'Notified', 'Beworben'],
    'months': ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
    'weekdays': ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],

    'sources.title': 'Karriereseiten', 'sources.addSource': '+ Quelle', 'sources.namePh': 'Name',
    'sources.urlPh': 'https://…', 'sources.delTitle': 'Entfernen',
    'sources.needNameUrl': 'Jede Quelle braucht Name und URL.',
    'sources.savedMsg': '✓ {n} Quellen gespeichert.', 'toast.sourcesSaved': 'Quellen gespeichert',

    'profile.savedMsg': '✓ Profil gespeichert. Greift beim nächsten Lauf / Anschreiben.',
    'toast.profileSaved': 'Profil gespeichert',

    'prompts.savedMsg': '✓ Prompts gespeichert. Greifen sofort beim nächsten Lauf / Anschreiben.',
    'prompts.resetHint': 'Standardwerte eingesetzt – zum Übernehmen „Speichern“ klicken.',
    'prompts.defaultBtn': '↺ Standard', 'prompts.defaultTitle': 'Standard einsetzen',
    'toast.promptsSaved': 'Prompts gespeichert',

    'run.ready': '● bereit', 'run.running': '● läuft…',
    'run.alreadyRunning': 'Lauf läuft bereits', 'run.doneToast': 'Lauf fertig – Jobs aktualisiert',

    'settings.savedMsg': '✓ Gespeichert. Änderungen greifen beim nächsten Lauf (GUI-Port erst nach Neustart).',
    'toast.settingsSaved': 'Einstellungen gespeichert',
    'restart.confirm': 'Den GUI-Dienst jetzt neu starten? Die Seite lädt anschließend neu.',
    'restart.running': '↻ Neustart läuft …', 'toast.restart': 'Dienst wird neu gestartet …',

    // Static section titles / intros
    'profile.title': 'Profil / Lebenslauf',
    'profile.intro': 'Diese Angaben sendet die KI bei jeder Bewertung und beim Anschreiben. Je konkreter, desto besser die Treffer. Mehrfachfelder: ein Eintrag pro Zeile.',
    'prompts.title': 'KI-Prompts',
    'prompts.intro': 'Anweisungen, die an Claude gesendet werden. Änderungen greifen sofort beim nächsten Lauf / Anschreiben. Leeres Feld = Standard.',
    'run.title': 'Pipeline-Lauf',
    'run.intro': 'Startet <code>node index.js --once</code>: scrapen, analysieren, benachrichtigen, exportieren.',
    'run.consolePlaceholder': 'Noch keine Ausgabe. Starte einen Lauf, um Live-Logs zu sehen.',
    'run.history': 'Letzte Läufe', 'run.show': 'Anzahl',
    'run.noRuns': 'Noch keine Läufe aufgezeichnet.',
    'run.noSources': 'Keine Quellen-Daten für diesen Lauf.',
    'run.histHeaders': ['Quelle', 'Gefunden', 'Analysiert', 'Neu rel.', 'Ges. rel.', 'Benachrichtigt'],
    'settings.title': 'Einstellungen',
    'settings.intro': 'Alle Variablen aus <code>.env</code>. Änderungen greifen beim nächsten Lauf; <code>GUI-Port</code> erst nach Neustart der GUI.',
    'appearance.title': 'Darstellung',
    'appearance.schemeHelp': 'Farbschema der Oberfläche. „Automatisch“ folgt der Einstellung deines Systems.',
    'appearance.light': '☀️ Hell', 'appearance.dark': '🌙 Dunkel', 'appearance.auto': '🖥️ Automatisch',
    'appearance.themeLabel': 'Farbthema', 'appearance.themeDefault': 'Standard (Grün)', 'appearance.themePink': '🌸 Rosa',
    'appearance.langLabel': 'Sprache',
    'setup.cardTitle': 'Einrichtungs-Assistent',
    'setup.cardHelp': 'Den geführten Ersteinrichtungs-Assistenten erneut öffnen, oder ihn gefahrlos im Debug-Modus testen (schreibt in eine Sandbox, deine echten Daten bleiben unberührt).',
    'setup.openBtn': '⚙ Assistent öffnen', 'setup.debugBtn': '🧪 Im Debug-Modus testen',
    'setup.debugBtnTitle': 'Test-Lauf in Sandbox – ändert nichts an deinen Daten',
    'restart.title': 'Dienst neu starten',
    'restart.help': 'Startet den GUI-Server neu, damit Änderungen am <code>GUI-Port</code> übernommen werden. Laufende Pipeline-Läufe bitte vorher beenden.',
    'restart.btn': '↻ Jetzt neu starten',

    'backup.title': 'Datensicherung',
    'backup.help': 'Vollständige Sicherungen der Datenbank (alle Klienten, Jobs, Verlauf). Vor jedem Import wird automatisch eine Sicherung erstellt – so kann nichts verloren gehen. Tägliche Sicherungen laufen automatisch (in den Einstellungen oben konfigurierbar).',
    'backup.createBtn': '＋ Sicherung erstellen', 'backup.uploadBtn': '⬆ Backup hochladen',
    'backup.none': 'Noch keine Sicherungen vorhanden.',
    'backup.colDate': 'Datum', 'backup.colType': 'Typ', 'backup.colSize': 'Größe',
    'backup.download': 'Herunterladen', 'backup.restore': 'Wiederherstellen',
    'backup.type.daily': 'Täglich', 'backup.type.manual': 'Manuell',
    'backup.type.preimport': 'Vor Import', 'backup.type.upload': 'Hochgeladen', 'backup.type.unknown': 'Unbekannt',
    'backup.creating': 'Sicherung wird erstellt …', 'backup.created': '✓ Sicherung erstellt.',
    'backup.uploading': 'Backup wird hochgeladen …', 'backup.uploaded': '✓ Backup hochgeladen.',
    'backup.restoring': 'Wiederherstellung läuft …',
    'backup.restored': '✓ Wiederhergestellt. Vorheriger Stand gesichert als {safety}.',
    'backup.restoreConfirm': 'Aktuelle Daten werden durch dieses Backup ersetzt.\n\nKeine Sorge: Vorher wird automatisch eine Sicherung des jetzigen Standes erstellt. Fortfahren?',
    'backup.error': 'Fehler: ',

    'update.title': 'Updates',
    'update.help': 'Holt die neueste Version aus dem GitHub-Repository (<code>git pull</code>). Code-Änderungen greifen nach einem Neustart.',
    'update.btn': '↧ Nach Updates suchen', 'update.checking': 'Aktualisiere …',
    'update.upToDate': '✓ Bereits auf dem neuesten Stand.',
    'update.updated': '✓ Aktualisiert. Neu starten, um die Änderungen anzuwenden.',
    'update.depsChanged': '⚠ Abhängigkeiten haben sich geändert – bitte im Terminal „npm install“ ausführen und dann neu starten.',
    'update.failed': 'Update fehlgeschlagen: ', 'update.applyBtn': '↻ Neu starten & anwenden',

    // Settings field chrome (frontend bits around backend labels)
    'settings.required': 'erforderlich', 'settings.secretSet': '•••••••• gesetzt',
    'settings.secretUnset': 'nicht gesetzt', 'settings.defaultPrefix': 'Standard: ',
    'settings.revealTitle': 'Anzeigen/Verbergen',

    // Setup wizard – static (non-schema) strings
    'wiz.debugBadge': '🧪 Debug-Modus · Sandbox',
    'wiz.langLabel': 'Sprache / Language',
    'wiz.welcomeTitle': 'Willkommen 👋',
    'wiz.welcomeSubtitle': 'Richte deinen Job-Alert in wenigen Schritten ein.',
    'wiz.welcomeBody': 'Dieser Assistent führt dich durch alle nötigen Einstellungen — einen Schritt nach dem anderen. Du brauchst dafür:',
    'wiz.welcomeLi1': 'einen <strong>Anthropic API-Schlüssel</strong> (für die KI-Bewertung),',
    'wiz.welcomeLi2': 'einen <strong>Telegram-Bot</strong> (für Benachrichtigungen),',
    'wiz.welcomeLi3': 'ein paar Angaben zu <strong>dir</strong> und den <strong>Firmen</strong>, die dich interessieren.',
    'wiz.welcomeFootnote': 'Alles lässt sich später unter „Einstellungen“ ändern.',
    'wiz.start': "Los geht's →",
    'wiz.finishTitle': 'Fertig 🎉',
    'wiz.finishSubtitle': 'Die Einrichtung ist abgeschlossen.',
    'wiz.finishBody': 'Alles eingerichtet! Du kannst jetzt einen ersten Lauf starten, um sofort nach passenden Stellen zu suchen.',
    'wiz.runNow': 'Ersten Lauf direkt starten',
    'wiz.debugNoRun': 'Im Debug-Modus wird kein echter Lauf gestartet.',
    'wiz.finish': 'Abschließen', 'wiz.complete': 'Speichern & Abschließen', 'wiz.saveNext': 'Speichern & Weiter →',
    'wiz.back': '← Zurück', 'wiz.skip': 'Überspringen', 'wiz.next': 'Weiter →', 'wiz.close': 'Schließen',
    'wiz.required': 'erforderlich', 'wiz.reveal': 'Anzeigen/Verbergen',
    'wiz.addSource': '+ Quelle', 'wiz.sourceNamePh': 'Name', 'wiz.sourceUrlPh': 'https://… (Karriere-/Stellenseite)', 'wiz.del': 'Entfernen',
    'wiz.testTelegram': '✈ Testnachricht senden', 'wiz.sending': '…wird gesendet',
    'wiz.testOk': '✓ gesendet – schau in deinen Chat!',
    'wiz.error': 'Fehler: ', 'wiz.loadFailed': 'Einrichtung konnte nicht geladen werden: ',
    'wiz.alreadyComplete': 'Einrichtung ist bereits vollständig.',
    'wiz.closeConfirm': 'Einrichtung wirklich schließen? Du kannst sie später unter „Einstellungen“ fortsetzen.',
    'wiz.completeRun': 'Einrichtung fertig – erster Lauf gestartet.',
    'wiz.debugDone': 'Debug-Durchlauf abgeschlossen.', 'wiz.setupDone': 'Einrichtung abgeschlossen.',
  },
  en: {
    'tab.jobs': 'Jobs', 'tab.stats': 'Statistics', 'tab.sources': 'Sources',
    'tab.profile': 'Profile', 'tab.prompts': 'Prompts', 'tab.run': 'Run', 'tab.settings': 'Settings',
    'tab.clients': 'Clients',
    'btn.startRun': '▶ Start run', 'btn.save': 'Save', 'btn.reset': 'Reset',

    // ── Auth / clients (multi-tenant) ──
    'auth.title': 'Sign in', 'auth.subtitle': 'Please sign in with the operator credentials.',
    'auth.user': 'User', 'auth.password': 'Password', 'auth.login': 'Sign in', 'auth.logout': 'Sign out',
    'client.active': 'Client', 'client.activeBadge': 'active',
    'clients.title': 'Clients', 'clients.add': '+ Client', 'clients.inactive': 'inactive',
    'clients.intro': 'Create clients and maintain their Telegram chat ID. CV, sources, filters and prompts are managed per client via the other tabs — pick the active client in the top right.',
    'clients.select': 'select', 'clients.chatId': 'Telegram chat ID',
    'clients.enabled': 'active in run', 'clients.telegram': 'Telegram', 'clients.expiry': 'Expiry alerts',
    'clients.minScore': 'Min. relevance score (empty = global)', 'clients.tgTest': 'Telegram test',
    'clients.editContent': "Edit this client's content",
    'clients.delete': 'Delete', 'clients.saved': 'Client saved', 'clients.created': 'Client created',
    'clients.deleted': 'Client deleted', 'clients.tgOk': 'Test message sent ✓',
    'clients.namePrompt': 'Name of the new client:',
    'clients.delConfirm': 'Really delete client “{name}" with all its jobs?',

    'jobs.searchPh': 'Search by title, company, location…', 'jobs.allSources': 'All sources',
    'jobs.allStatuses': 'All statuses', 'jobs.empty': 'No jobs found.',
    'jobs.of': 'of', 'jobs.statusPlaceholder': 'Status…',
    'jobs.sortRelevance': 'Relevance', 'jobs.sortOldest': 'Oldest first', 'jobs.sortNewest': 'Newest first',
    'status.none': 'Not applied', 'status.applied': 'Applied', 'status.interview': 'Interview',
    'status.offer': 'Offer', 'status.rejected': 'Rejected',
    'job.coverTitle': 'Create cover letter', 'job.openTitle': 'Open',
    'job.ignoreTitle': 'Hide as irrelevant', 'job.statusTitle': 'Application status',
    'job.confirmIgnore': 'Hide this job as irrelevant?',
    'stat.relevantJobs': 'Relevant jobs', 'stat.topMatch': 'Top match (≥8)',
    'stat.avgScore': 'Avg. score', 'stat.applied': 'Applied',

    'toast.loadError': 'Error loading: ', 'toast.statusReset': 'Status reset',
    'toast.hidden': 'Hidden', 'toast.error': 'Error: ',
    'toast.copied': 'Copied to clipboard', 'toast.copiedShort': 'Copied',

    'cover.title': 'Cover letter', 'cover.loading': 'Generating cover letter…',
    'cover.regen': '↻ Regenerate', 'cover.copy': '📋 Copy', 'cover.close': 'Close',
    'cover.generate': '✎ Generate cover letter',
    'cover.notesLabel': 'Extra notes for this cover letter (optional)',
    'cover.notesPlaceholder': 'e.g. specific motivation, relevant projects, salary expectation …',
    'cover.applied': '✓ Mark as applied', 'cover.appliedDone': '✓ Applied',

    'stats.activity': 'Application activity', 'stats.less': 'less', 'stats.more': 'more',
    'stats.topCompanies': 'Most applications (companies)', 'stats.topSources': 'Top sources (relevant jobs)',
    'stats.runHistory': 'Run history', 'stats.runHistorySub': 'found vs. relevant per run',
    'stats.runOverview': 'Run overview', 'stats.error': 'Statistics error: ',
    'stats.cardTotal': 'Total jobs', 'stats.cardRelevant': 'Relevant',
    'stats.cardNotified': 'Notified', 'stats.cardApplied': 'Applied',
    'stats.noData': 'No data yet.', 'stats.noApplications': 'No applications yet.',
    'stats.legendFound': 'Found', 'stats.legendRelevant': 'Relevant',
    'stats.inLastYear': ' in the last year', 'stats.lastRun': 'last run · ', 'stats.total': 'Total',
    'stats.allTimeSub': 'All time · per-run columns appear after the next run',
    'stats.headers': ['Company', 'Found', 'Per site', 'New (DB)', 'Blocked', 'Analyzed', 'New rel.', 'Total rel.', 'Notified'],
    'stats.headersFallback': ['Company', 'Found', 'Analyzed', 'Total rel.', 'Notified', 'Applied'],
    'months': ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    'weekdays': ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],

    'sources.title': 'Career pages', 'sources.addSource': '+ Source', 'sources.namePh': 'Name',
    'sources.urlPh': 'https://…', 'sources.delTitle': 'Remove',
    'sources.needNameUrl': 'Each source needs a name and a URL.',
    'sources.savedMsg': '✓ Saved {n} sources.', 'toast.sourcesSaved': 'Sources saved',

    'profile.savedMsg': '✓ Profile saved. Applies on the next run / cover letter.',
    'toast.profileSaved': 'Profile saved',

    'prompts.savedMsg': '✓ Prompts saved. Apply immediately on the next run / cover letter.',
    'prompts.resetHint': 'Defaults inserted – click “Save” to apply.',
    'prompts.defaultBtn': '↺ Default', 'prompts.defaultTitle': 'Insert default',
    'toast.promptsSaved': 'Prompts saved',

    'run.ready': '● ready', 'run.running': '● running…',
    'run.alreadyRunning': 'Run already in progress', 'run.doneToast': 'Run finished – jobs updated',

    'settings.savedMsg': '✓ Saved. Changes apply on the next run (GUI port only after a restart).',
    'toast.settingsSaved': 'Settings saved',
    'restart.confirm': 'Restart the GUI service now? The page will reload afterward.',
    'restart.running': '↻ Restarting …', 'toast.restart': 'Restarting service …',

    // Static section titles / intros
    'profile.title': 'Profile / CV',
    'profile.intro': 'These details are sent to the AI for every assessment and cover letter. The more specific, the better the matches. Multi-value fields: one entry per line.',
    'prompts.title': 'AI prompts',
    'prompts.intro': 'Instructions sent to Claude. Changes take effect immediately on the next run / cover letter. Empty field = default.',
    'run.title': 'Pipeline run',
    'run.intro': 'Runs <code>node index.js --once</code>: scrape, analyze, notify, export.',
    'run.consolePlaceholder': 'No output yet. Start a run to see live logs.',
    'run.history': 'Recent runs', 'run.show': 'Show',
    'run.noRuns': 'No runs recorded yet.',
    'run.noSources': 'No per-source data for this run.',
    'run.histHeaders': ['Source', 'Found', 'Analyzed', 'New rel.', 'Total rel.', 'Notified'],
    'settings.title': 'Settings',
    'settings.intro': 'All variables from <code>.env</code>. Changes apply on the next run; <code>GUI port</code> only after restarting the GUI.',
    'appearance.title': 'Appearance',
    'appearance.schemeHelp': 'Color scheme of the interface. “Automatic” follows your system setting.',
    'appearance.light': '☀️ Light', 'appearance.dark': '🌙 Dark', 'appearance.auto': '🖥️ Automatic',
    'appearance.themeLabel': 'Color theme', 'appearance.themeDefault': 'Default (green)', 'appearance.themePink': '🌸 Pink',
    'appearance.langLabel': 'Language',
    'setup.cardTitle': 'Setup wizard',
    'setup.cardHelp': 'Reopen the guided first-run setup wizard, or test it safely in debug mode (writes to a sandbox, your real data stays untouched).',
    'setup.openBtn': '⚙ Open wizard', 'setup.debugBtn': '🧪 Test in debug mode',
    'setup.debugBtnTitle': 'Test run in sandbox – changes nothing in your data',
    'restart.title': 'Restart service',
    'restart.help': 'Restarts the GUI server so changes to the <code>GUI port</code> take effect. Please stop any running pipeline runs first.',
    'restart.btn': '↻ Restart now',

    'backup.title': 'Data backup',
    'backup.help': 'Full backups of the database (all clients, jobs, history). Before every import a backup is taken automatically — so nothing can be lost. Daily backups run automatically (configurable in the settings above).',
    'backup.createBtn': '＋ Create backup', 'backup.uploadBtn': '⬆ Upload backup',
    'backup.none': 'No backups yet.',
    'backup.colDate': 'Date', 'backup.colType': 'Type', 'backup.colSize': 'Size',
    'backup.download': 'Download', 'backup.restore': 'Restore',
    'backup.type.daily': 'Daily', 'backup.type.manual': 'Manual',
    'backup.type.preimport': 'Pre-import', 'backup.type.upload': 'Uploaded', 'backup.type.unknown': 'Unknown',
    'backup.creating': 'Creating backup …', 'backup.created': '✓ Backup created.',
    'backup.uploading': 'Uploading backup …', 'backup.uploaded': '✓ Backup uploaded.',
    'backup.restoring': 'Restoring …',
    'backup.restored': '✓ Restored. Previous state saved as {safety}.',
    'backup.restoreConfirm': 'This backup will replace your current data.\n\nDon\'t worry: a backup of the current state is taken automatically first. Continue?',
    'backup.error': 'Error: ',

    'update.title': 'Updates',
    'update.help': 'Pulls the latest version from the GitHub repository (<code>git pull</code>). Code changes take effect after a restart.',
    'update.btn': '↧ Check for updates', 'update.checking': 'Updating …',
    'update.upToDate': '✓ Already up to date.',
    'update.updated': '✓ Updated. Restart to apply the changes.',
    'update.depsChanged': '⚠ Dependencies changed – please run “npm install” in the terminal, then restart.',
    'update.failed': 'Update failed: ', 'update.applyBtn': '↻ Restart & apply',

    // Settings field chrome
    'settings.required': 'required', 'settings.secretSet': '•••••••• set',
    'settings.secretUnset': 'not set', 'settings.defaultPrefix': 'Default: ',
    'settings.revealTitle': 'Show/hide',

    // Setup wizard – static (non-schema) strings
    'wiz.debugBadge': '🧪 Debug mode · Sandbox',
    'wiz.langLabel': 'Language / Sprache',
    'wiz.welcomeTitle': 'Welcome 👋',
    'wiz.welcomeSubtitle': 'Set up your job alert in a few steps.',
    'wiz.welcomeBody': 'This wizard guides you through all the required settings — one step at a time. You will need:',
    'wiz.welcomeLi1': 'an <strong>Anthropic API key</strong> (for the AI scoring),',
    'wiz.welcomeLi2': 'a <strong>Telegram bot</strong> (for notifications),',
    'wiz.welcomeLi3': 'a few details about <strong>you</strong> and the <strong>companies</strong> you’re interested in.',
    'wiz.welcomeFootnote': 'You can change everything later under “Settings”.',
    'wiz.start': "Let's go →",
    'wiz.finishTitle': 'Done 🎉',
    'wiz.finishSubtitle': 'Setup is complete.',
    'wiz.finishBody': 'All set! You can now start a first run to search for matching jobs right away.',
    'wiz.runNow': 'Start the first run right away',
    'wiz.debugNoRun': 'No real run is started in debug mode.',
    'wiz.finish': 'Finish', 'wiz.complete': 'Save & finish', 'wiz.saveNext': 'Save & continue →',
    'wiz.back': '← Back', 'wiz.skip': 'Skip', 'wiz.next': 'Continue →', 'wiz.close': 'Close',
    'wiz.required': 'required', 'wiz.reveal': 'Show/hide',
    'wiz.addSource': '+ Source', 'wiz.sourceNamePh': 'Name', 'wiz.sourceUrlPh': 'https://… (careers/jobs page)', 'wiz.del': 'Remove',
    'wiz.testTelegram': '✈ Send test message', 'wiz.sending': '…sending',
    'wiz.testOk': '✓ sent – check your chat!',
    'wiz.error': 'Error: ', 'wiz.loadFailed': 'Could not load setup: ',
    'wiz.alreadyComplete': 'Setup is already complete.',
    'wiz.closeConfirm': 'Really close setup? You can resume it later under “Settings”.',
    'wiz.completeRun': 'Setup complete – first run started.',
    'wiz.debugDone': 'Debug run completed.', 'wiz.setupDone': 'Setup complete.',
  },
};

// English overrides for the backend SETTINGS_SCHEMA (keyed by setting key / group).
const SETTINGS_GROUPS_EN = {
  'Schlüssel & Telegram': 'Keys & Telegram',
  'KI-Modelle': 'AI models',
  'Analyse & Filter': 'Analysis & filters',
  'Performance': 'Performance',
  'Server': 'Server',
  'Datensicherung': 'Data backup',
  'Klienten (Mehrbenutzer)': 'Clients (multi-user)',
};
const SETTINGS_LABELS_EN = {
  ANTHROPIC_API_KEY: 'Anthropic API Key',
  TELEGRAM_BOT_TOKEN: 'Telegram Bot Token',
  TELEGRAM_CHAT_ID: 'Telegram Chat ID',
  TELEGRAM_NOTIFICATIONS: 'Telegram enabled',
  EXPIRY_NOTIFICATIONS: 'Expiry notifications',
  ANALYZER_MODEL: 'Analysis model',
  COVER_LETTER_MODEL: 'Cover letter model',
  MIN_RELEVANCE_SCORE: 'Min. relevance score',
  EXPIRY_THRESHOLD_HOURS: 'Expiry threshold (hrs)',
  ANALYSIS_CONCURRENCY: 'Analysis concurrency',
  SCRAPE_CONCURRENCY: 'Scraper concurrency',
  CRON_SCHEDULE: 'Schedule (cron)',
  GUI_PORT: 'GUI port',
  BACKUP_ENABLED: 'Daily backup',
  BACKUP_RETENTION_DAYS: 'Retention (days)',
  CLIENTS_ENABLED: 'Show client management',
};
const SETTINGS_HELP_EN = {
  ANTHROPIC_API_KEY: 'API key from console.anthropic.com',
  TELEGRAM_BOT_TOKEN: 'Bot token from @BotFather (optional – leave empty if Telegram is not used)',
  TELEGRAM_CHAT_ID: 'Your chat ID for notifications (optional)',
  TELEGRAM_NOTIFICATIONS: "Set to 'off' to disable Telegram notifications – relevant jobs stay visible in the GUI",
  EXPIRY_NOTIFICATIONS: "Set to 'off' to stop Telegram messages for expired jobs – new jobs are still reported",
  ANALYZER_MODEL: 'Claude model for relevance scoring (cheap/fast recommended)',
  COVER_LETTER_MODEL: 'Claude model for cover letters (a stronger model recommended)',
  MIN_RELEVANCE_SCORE: 'Minimum score (1–10) at which a job counts as relevant',
  EXPIRY_THRESHOLD_HOURS: 'Hours without re-sighting before a reported job is marked expired',
  ANALYSIS_CONCURRENCY: 'Parallel Claude analyses (increase carefully – rate limits)',
  SCRAPE_CONCURRENCY: 'Parallel browser workers while scraping',
  CRON_SCHEDULE: 'node-cron expression. Default: hourly on the hour',
  GUI_PORT: 'Web UI port (requires a GUI restart)',
  BACKUP_ENABLED: 'Automatically create one database backup per day (even without an active run). Manual backup, import, download and upload stay available regardless.',
  BACKUP_RETENTION_DAYS: 'How many daily backups to keep; older ones are deleted automatically. Manual, uploaded and pre-import backups are always kept.',
  CLIENTS_ENABLED: 'Show the multi-user management (Clients tab and the client selector in the top bar). Leave off for private use. Reload the page for the change to take effect.',
};

// English overrides for the setup wizard schema (src/setup.js), by step id / field key.
const WIZARD_STEPS_EN = {
  apikey: { title: 'Anthropic API key', subtitle: 'The AI rates how well each job matches you.',
    intro: 'Create a key at console.anthropic.com → "API Keys". It starts with "sk-ant-".' },
  telegram: { title: 'Telegram notifications', subtitle: 'Matching jobs as a message in your Telegram – or skip it entirely.',
    intro: 'Optional: message @BotFather on Telegram, create a bot and copy the token. You can get the chat ID e.g. via @userinfobot. If you don’t want push messages, just turn them off – you’ll still see relevant jobs anytime in the GUI.' },
  profile: { title: 'Your profile', subtitle: 'What the AI looks at when rating jobs for you.',
    intro: 'The more specific, the better the matches. Multi-value fields: one entry per line.' },
  sources: { title: 'Career pages', subtitle: 'Which company pages are searched for jobs.',
    intro: 'Add the careers/jobs pages of the companies you’re interested in. At least one source is required.' },
  filters: { title: 'Title filters', subtitle: 'Optional: pre-filter jobs by keywords in the title.',
    intro: 'Saves AI costs. Blocked titles are never analyzed; priority keywords raise the score. Leaving this empty is perfectly fine.' },
  tuning: { title: 'Fine-tuning', subtitle: 'Optional: thresholds and schedule. The defaults are sensible.',
    intro: 'Can be changed anytime later under "Settings".' },
};
const WIZARD_FIELDS_EN = {
  ANTHROPIC_API_KEY: { label: 'Anthropic API Key', help: 'From console.anthropic.com', placeholder: 'sk-ant-…' },
  TELEGRAM_NOTIFICATIONS: { label: 'Use Telegram notifications', help: 'Off = no push messages. Relevant jobs still appear in the GUI.' },
  TELEGRAM_BOT_TOKEN: { label: 'Bot Token', help: 'From @BotFather', placeholder: '123456:ABC-DEF…' },
  TELEGRAM_CHAT_ID: { label: 'Chat ID', help: 'Your personal chat ID', placeholder: '987654321' },
  'cv.name': { label: 'Name', placeholder: 'First and last name' },
  'cv.currentRole': { label: 'Current role / status', placeholder: 'e.g. Mechanical engineering graduate' },
  'cv.yearsOfExperience': { label: 'Work experience (years)', placeholder: '3' },
  'cv.summary': { label: 'Short profile', help: '2–3 sentences: field, strengths, what you’re looking for. Goes straight to the AI.', placeholder: 'Mechanical engineer focused on additive manufacturing …' },
  'cv.skills.domain': { label: 'Professional skills', help: 'One per line' },
  'cv.languages': { label: 'Languages', help: 'e.g. German (native)' },
  'preferences.desiredRoles': { label: 'Desired roles', help: 'Job titles you’re looking for — one per line' },
  'preferences.locations': { label: 'Locations', help: 'Cities, "Remote", "Hybrid" …' },
  'preferences.industries': { label: 'Industries' },
  'preferences.dealbreakers': { label: 'Dealbreakers', help: 'What you absolutely don’t want' },
  sources: { label: 'Sources' },
  titleBlocklist: { label: 'Blocklist (skip titles)', help: 'One keyword per line, e.g. internship' },
  priorityKeywords: { label: 'Priority keywords', help: 'Titles containing these words are preferred' },
  MIN_RELEVANCE_SCORE: { label: 'Min. relevance score', help: 'A job counts as a match from this score (1–10)' },
  CRON_SCHEDULE: { label: 'Schedule (cron)', help: 'How often to search. Default: hourly' },
};

let lang = (() => { try { return localStorage.getItem('lang') === 'en' ? 'en' : 'de'; } catch { return 'de'; } })();

const t = (key) => (I18N[lang]?.[key] ?? I18N.de[key] ?? key);
const locale = () => (lang === 'en' ? 'en-US' : 'de-DE');
const statusLabel = (s) => t('status.' + s);
const applicationsN = (n) => lang === 'en'
  ? `${n} application${n === 1 ? '' : 's'}`
  : `${n} Bewerbung${n === 1 ? '' : 'en'}`;
const careerPagesN = (n) => lang === 'en'
  ? `${n} career page${n === 1 ? '' : 's'}`
  : `${n} Karriereseite${n === 1 ? '' : 'n'}`;

// Settings / wizard localizers: English override when present, else the German
// text the backend already sent.
const tSetGroup = (g) => (lang === 'en' ? (SETTINGS_GROUPS_EN[g] || g) : g);
const tSetLabel = (key, fallback) => (lang === 'en' ? (SETTINGS_LABELS_EN[key] || fallback) : fallback);
const tSetHelp = (key, fallback) => (lang === 'en' ? (SETTINGS_HELP_EN[key] ?? fallback) : fallback);
const wzStep = (id, field) => (lang === 'en' ? WIZARD_STEPS_EN[id]?.[field] : undefined);
const wzField = (key, field) => (lang === 'en' ? WIZARD_FIELDS_EN[key]?.[field] : undefined);

// Translate all static markup carrying data-i18n* attributes. Pass a root element
// to translate a freshly built fragment (e.g. a dynamically created card).
function applyStaticI18n(root = document) {
  qsa('[data-i18n]', root).forEach(el => { el.textContent = t(el.dataset.i18n); });
  qsa('[data-i18n-html]', root).forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  qsa('[data-i18n-ph]', root).forEach(el => { el.setAttribute('placeholder', t(el.dataset.i18nPh)); });
  qsa('[data-i18n-title]', root).forEach(el => { el.setAttribute('title', t(el.dataset.i18nTitle)); });
}

// Components register here to re-render their dynamic content on a language change.
const langListeners = [];
function onLangChange(fn) { langListeners.push(fn); }
function setLang(val) {
  lang = (val === 'en') ? 'en' : 'de';
  try { localStorage.setItem('lang', lang); } catch { /* ignore */ }
  document.documentElement.setAttribute('lang', lang);
  applyStaticI18n();
  langListeners.forEach(fn => { try { fn(lang); } catch (e) { console.error(e); } });
}
