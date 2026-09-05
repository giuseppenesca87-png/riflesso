'use strict';

/* ------------------------------------------------------------------
   Lingue. Inglese di default, italiano a scelta. I testi che arrivano
   dal Mac sono **codici** (`code` + dati): la frase si compone qui,
   così il cambio lingua vale subito anche per i rifiuti e gli avvisi.
------------------------------------------------------------------ */

(function (global) {
  const STORE = 'riflesso.lang';

  const EN = {
    'doc.title': 'Riflesso — your Claude chats',
    'doc.manifest': 'Riflesso — Claude on your phone',
    'doc.manifest_desc': 'Your Claude conversations, on your phone.',

    'pair.sub': 'Your Claude conversations, from your phone.',
    'pair.hint': 'Open Riflesso on your Mac and type the eight-digit code you see. Scan the QR beside it and you skip this screen.',
    'pair.button': 'Pair',
    'pair.connecting': 'Pairing…',
    'pair.need_digits': 'Enter all {n} digits.',
    'pair.rejected': 'Code rejected.',

    'list.chats': 'Chats',
    'list.routines': 'Routines',
    'list.search_chats': 'Search titles and messages…',
    'list.search_routines': 'Search routines…',
    'list.one_chat': '1 chat',
    'list.n_chats': '{n} chats',
    'list.one_routine': '1 routine',
    'list.n_routines': '{n} routines',
    'list.empty_chat': 'No chats found.',
    // Le due sezioni che il Mac ha e che non sono gruppi veri.
    'list.pinned': 'Pinned',
    'list.ungrouped': 'Ungrouped',
    'list.empty_routine': 'No routines found.',
    'list.loading': 'Reading chats from the Mac…',
    'list.you': 'You: ',
    'list.no_transcript': 'text no longer on the Mac',
    'list.now': 'now',
    'list.yesterday': 'yesterday',
    'list.today': 'today',

    'chat.conversation': 'Conversation',
    'chat.opening': 'opening…',
    'chat.cant_open': 'Couldn’t open.',
    'chat.working': 'Working',
    'chat.model': 'Model',
    'chat.load_more': 'Load earlier messages',
    'chat.loading': 'loading…',
    'chat.placeholder': 'Message this chat…',
    'chat.claude_working': 'Claude is working…',
    'chat.failed': 'That didn’t work.',
    'chat.thinking': 'thinking',
    'chat.cmd_out': 'command output',
    'chat.document': 'document',
    'chat.image': 'image',
    'chat.image_bad': 'image unreadable',
    'chat.tool_pending': 'no result yet: it isn’t in the file.',
    'chat.tool_result': 'result',
    'chat.tool_empty': 'no details.',
    'chat.commands': 'commands',
    'chat.tools': 'tools',
    'chat.copy': 'copy',
    'chat.copied': 'copied',
    'chat.code': 'code',
    'chat.chars': '{n} characters',
    'chat.tokens': 'tokens',
    'chat.photo': 'photo',
    'chat.file_too_big': 'That file is too big: {max} at most. Nothing was sent.',
    'chat.upload_failed': 'The attachment didn’t make it to the Mac. Nothing was sent.',

    'model.sheet': 'Model & effort',
    'model.effort': 'Effort',
    'model.note.fable': 'most capable',
    'model.note.opus': 'the workhorse',
    'model.note.sonnet': 'balanced',
    'model.note.opus48': 'previous generation',
    'model.note.haiku': 'fastest',
    'effort.low': 'Low',
    'effort.medium': 'Medium',
    'effort.high': 'High',
    'effort.extra': 'Extra',
    'effort.max': 'Max',
    'effort.ultracode': 'Ultracode',
    'effort.haiku': 'Haiku has no effort control. Nothing to set. Fable, Opus, and Sonnet have it.',
    'effort.help': 'Effort isn’t a command: the app moves the slider in Claude on the Mac, the way you would. It applies to this conversation, and if the Mac is in use the app waits instead of touching it.',
    'effort.moving': 'Moving effort to {name}…',
    'model.switching': 'Switching to {name}: asking Claude on the Mac…',

    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.input': 'Input to the Mac',
    'settings.hybrid': 'Hybrid (recommended)',
    'settings.direct': 'Direct only',
    'settings.global': 'Global only',
    'settings.enter': 'Return to send',
    'settings.routines': 'Scheduled routines',
    'settings.back_chats': 'Back to chats',
    'settings.forget': 'Forget this device',
    'settings.blurb': 'Writing from here goes <b>through Claude on the Mac</b>: the message is delivered into the same conversation and sent from there, so it shows up on the Mac too. If someone is using the Mac, sending waits instead of typing over them.',
    'settings.cli': 'The <code>claude</code> command isn’t on this Mac. You can read chats, but you can’t reply.',

    'aria.back_list': 'Back to chats',
    'aria.settings': 'Settings',
    'aria.back': 'Back',
    'aria.model': 'Model for this chat',
    'aria.stop': 'Stop',
    'aria.send': 'Send',
    'aria.model_effort': '{model}, effort {effort}. Tap to change.',
    'aria.attach': 'Attach a photo or a file',
    'aria.drop_file': 'Remove attachment',
    'aria.mic': 'Dictate a message',
    'aria.mic_stop': 'Stop recording',

    // La voce: si registra qui, si trascrive sul Mac, il testo torna nel
    // riquadro. Ogni passo si dice, e ogni rifiuto dice cosa fare.
    'voice.recording': 'Recording… tap the microphone again to stop.',
    'voice.transcribing': 'Transcribing on the Mac…',
    'voice.empty': 'Nothing was heard. Try again, closer to the phone.',
    'voice.no_mic': 'The microphone isn’t allowed. Allow it for this page (Safari: aA → Website Settings → Microphone) and try again.',
    'voice.unsupported': 'This browser can’t record in a format the Mac reads. Use the keyboard’s dictation instead: it writes in the same box.',
    'voice.failed': 'Couldn’t transcribe. Nothing was sent. The keyboard’s dictation still works in the box.',
    'voice.too_long': 'Recording stopped after {min} minutes: that’s the most one message can hold.',
    'settings.dictation': '<b>Dictation.</b> The microphone button records on the phone; the Mac turns it into text — on the Mac itself, nothing leaves it — and puts the text in the box for you to check before sending. The keyboard’s own dictation writes in the same box too, everywhere.',
    'settings.dictation_home': '<b>Dictation.</b> On the home network (http) the page can’t use the microphone, so the button isn’t shown here: use the keyboard’s dictation, which writes in the same box. Through the bridge (https) the button is there.',

    'status.connected': 'connected',
    'status.disconnected': 'disconnected',
    'status.net_error': 'network error',
    'status.dropped': 'connection dropped',
    'status.connecting': 'connecting…',
    'status.offline': 'not connected',

    // La strada, scritta sempre: rete di casa, diretta (un inoltro davanti
    // al Mac, riconosciuto dalla sonda), ponte.
    'road.home': 'home network · {host}',
    'road.direct': 'direct link · {host}',
    'road.bridge_home': 'bridge · at home ({host})',
    'road.bridge_away': 'bridge · away ({host})',
    'road.bridge_relay': 'bridge · relay ({host})',
    'road.bridge_connecting': 'bridge · connecting… ({host})',
    'road.bridge_down': 'bridge · not connected ({host})',
    'road.label': 'Road: {road}',

    // Quando la coppia vincente passa dal rimbalzo TURN (diagnostica e riga di stato).
    'net.relay': 'relay',
    'net.looking': 'Looking for the Mac…',
    'net.waiting_mac': 'Waiting for the Mac…',
    'net.linking': 'Connecting to the Mac…',
    'net.closed': 'Connection closed',
    // Una richiesta che non parte vuol dire che il Mac non si raggiunge, e il
    // perché cambia con la strada. Le ragioni vere si nominano.
    'net.unreachable_home': 'The Mac isn’t answering on the home network. Is this phone on the same Wi-Fi, and is Riflesso open on the Mac?',
    'net.unreachable': 'The Mac isn’t answering behind this address. Check that Riflesso is open on the Mac and that this address still leads to it.',
    'net.unreachable_bridge': 'The bridge isn’t answering. Check this phone’s connection, or that the bridge is up.',
    'net.failed': 'Couldn’t connect: {detail}',

    'err.senza-segreto': 'Missing rendezvous secret. Type the code from the Riflesso panel.',
    'err.senza-gettone': 'This phone isn’t paired with the Mac yet. Type the code from the Riflesso panel.',
    'err.senza-codice': 'You need the code the Mac shows in its panel.',
    'err.senza-incontro': 'This phone is already paired, but it needs the code once more. The Mac has a fresh one.',
    // Quattro cause, non tre: la quarta — il Mac ha rigenerato il segreto
    // della sua stanza — è quella del 04/09/2026, e senza nominarla si
    // andava a cercare la rete.
    'err.nessuna-risposta': 'The Mac isn’t answering through the bridge. It’s one of four things: the Mac is off or asleep; Riflesso isn’t open; the bridge address on the Mac is different from this one; or the Mac regenerated its bridge room and this phone is knocking on the old one — then scan the QR on the Mac again.',
    'err.risposta-non-mia': 'Reply not recognized from the Mac. Trying again.',
    'err.risposta-vecchia': 'Reply expired. Trying again.',
    'err.impronta-diversa': 'The Mac’s fingerprint doesn’t match. Stopping instead of connecting to someone else.',
    'err.niente-strada': 'The bridge is up, but a direct link to the Mac won’t open from here. This happens on some locked-down networks. Try later, or from another connection.',
    'err.troppo-in-fretta': 'Too many tries at the bridge. Wait a minute and try again.',
    'err.caduto': 'Connection dropped',
    'err.il Mac non ha risposto': 'The Mac didn’t answer',

    'n.delivering': 'Handing this to Claude on the Mac…',
    'n.conversation_gone': 'This conversation is no longer among the ones on the Mac.',
    'n.conversation_in_use': 'This conversation is in use on the Mac right now. Writing here too would split the thread: close it on the Mac, or try again in a few seconds.',
    'n.live_locked': 'This conversation is open on the Mac right now: you can’t write from here until it’s free.',
    'n.fallback_unknown': 'This conversation isn’t one Claude has open on the Mac. Answering with the fallback engine. You’ll see it on the Mac when you reopen it.',
    'n.fallback_closed': 'Claude Desktop isn’t open on the Mac. Answering without it. Reopen the conversation on the Mac to see it.',
    'n.desktop_still_working': 'Desktop is still working. The reply will keep arriving here.',
    'n.transcript_missing': 'This conversation’s text isn’t on the Mac, so it can’t continue.',
    'n.transcript_gone': 'This conversation’s text is no longer on the Mac, so it can’t be opened or continued.',
    'n.unknown_model': 'Unknown model. Nothing was sent.',
    'n.model_needs_desktop': 'The model can only be changed with Claude open on the Mac.',
    'n.effort_invalid': 'That effort level isn’t valid.',
    'n.effort_needs_desktop': 'Effort can only be changed with Claude open on the Mac.',
    'n.moving_effort': 'Moving effort on the Mac…',
    'n.unknown_to_desktop': 'This conversation isn’t one Desktop knows. Open it once on the Mac.',
    'n.effort_unsupported': '{model} has no effort control. Fable, Opus, and Sonnet do.',
    'n.effort_changed': 'Effort updated.',
    'n.desktop_not_running': 'Claude isn’t open on the Mac.',
    'n.queued': 'Queued: Claude is still answering in this chat.',
    'n.cli_model_fallback': 'This session’s model isn’t usable from the CLI. Answering with the default.',
    'n.stopped': 'Stopped.',
    'n.mac_busy_wait': 'Someone is using the Mac. Waiting a moment.',
    'n.mac_in_use': 'The Mac is in use right now, and delivering would bring Claude to the front. Not stealing the desk. Try again in a bit.',
    'n.unknown_session_id': 'Don’t know how Desktop identifies this conversation.',
    'n.bad_conversation_url': 'Invalid conversation address.',
    'n.sidebar_ambiguous': 'Desktop doesn’t have a single sidebar row for “{title}”, and a direct link would duplicate this conversation. Open it on the Mac and try again.',
    'n.desktop_didnt_switch': 'Desktop didn’t switch to this conversation. Not writing blindly.',
    'n.effort_wrong_chat': 'Desktop isn’t on this conversation. Not touching effort.',
    'n.effort_picker_missing': 'Can’t find the effort control in the Claude window.',
    'n.effort_panel_closed': 'The effort panel didn’t open. Nothing was changed.',
    'n.effort_switched_away': 'While changing effort, Desktop switched conversation. Check — it may have changed there.',
    'n.effort_slider_stuck': 'The effort slider didn’t move.',
    'n.delivery_in_flight': 'A delivery is already in progress for this conversation.',
    'n.composer_unreadable': 'Can’t see Desktop’s compose box — Claude may be showing something else. Nothing was written. Try again in a moment.',
    'n.composer_not_empty': 'There’s already text in Claude’s box on the Mac. Leaving it. Clear it and try again.',
    'n.composer_unfocused': 'Couldn’t focus Claude’s compose box on the Mac.',
    'n.conversation_switched': 'Desktop switched conversation just now. Not writing.',
    'n.text_not_delivered': 'Couldn’t deliver the text to Desktop. The box on the Mac stayed empty. Nothing was sent.',
    'n.text_mismatch': 'A different text landed in Desktop’s box. Cleared it. Nothing was sent.',
    'n.conversation_changed_while_writing': 'While writing, the open conversation on the Mac changed. Removed the text. Nothing was sent. Try again.',
    'n.composer_lost_message': 'Desktop’s box no longer has the message. Nothing was sent.',
    'n.send_rejected': 'Desktop didn’t accept the send: the text was still in the box, so it was removed. Nothing was sent.',
    'n.composer_has_attachment': 'Claude’s box on the Mac already has an attachment ({name}). Leaving it. Clear it and try again.',
    'n.attach_failed': 'Couldn’t attach {name} in Claude on the Mac. Nothing was sent.',
    'n.attach_mismatch': 'A different attachment landed in Claude’s box. Removed it. Nothing was sent.',
    'n.attachment_needs_desktop': 'Attachments go through Claude on the Mac, and this conversation isn’t open there. Send the text on its own, or open the conversation on the Mac.',
    'n.upload_missing': 'The attachment didn’t arrive whole. Nothing was sent — try attaching it again.',
    'n.upload_too_big': 'That file is too big: {max}.',
    'n.upload_unknown': 'The upload was lost along the way. Try attaching it again.',
    'n.upload_out_of_order': 'The attachment arrived out of order. Try again.',
    'n.upload_failed': 'Couldn’t receive the attachment on the Mac.',
    'n.transcribe_unsupported_os': 'The Mac can’t transcribe: it needs macOS 26 or later. Use the keyboard’s dictation instead.',
    'n.transcribe_no_language': 'The Mac has no speech model for {detail}. Use the keyboard’s dictation instead.',
    'n.transcribe_installing': 'The Mac is downloading the speech model for {detail}. Try again in a minute.',
    'n.transcribe_bad_audio': 'The Mac couldn’t read the recording. Nothing was sent.',
    'n.transcribe_failed': 'Transcription failed on the Mac: {detail}',
    'n.message_too_long': 'Message too long to hand to the CLI.',
    'n.cli_missing': 'Can’t find the claude command on this Mac. The app uses the official CLI; without it, it can’t send.',
    'n.folder_gone': 'This chat’s folder no longer exists: {cwd}',
    'n.cli_start_failed': 'Can’t start the CLI: {detail}',
    'n.cli_error': '{detail}',
    'n.cli_error_generic': 'The CLI reported an error.',
    'n.cli_silent': 'The CLI exited without answering (code {status}).',
    'n.waiting_mac_busy': 'This chat is in use on the Mac right now. Waiting for it to finish.',
    'n.sending_anyway': 'The Mac is still working in this chat. Sending anyway, queued.',
    'n.permissions_blocked': 'Blocked by permissions: {list}. The reply may be incomplete.',
    'n.pin_wrong': 'Wrong code',
    'n.pin_expired': 'Code expired. The Mac has a new one.',
    'n.pin_locked': 'Too many tries. The code was regenerated. Check the Mac and try again in {seconds}s.',
    'n.pin_forgotten': 'This phone is no longer recognized. Type the code from the Mac panel.',
    'n.signed_out': 'Signed out. To come back, use the code on the Mac.',
    'n.remote_https': 'The bridge must be an https:// address.',
    'n.chat_unspecified': 'No chat specified.',
    'n.unauthorized': 'Not authorized.',
    'n.scheduled_task': 'scheduled task · {name}',
    'n.background_done': 'a background job finished',
    'n.interrupted': 'interrupted',

    'diag.version': 'version',
    'diag.cli': 'claude command',
    'diag.found': 'found',
    'diag.missing': 'NOT FOUND',
    'diag.ax': 'accessibility',
    'diag.ax_ok': 'granted',
    'diag.ax_no': 'MISSING — the mirror can’t send input',
    'diag.devices': 'paired devices',
    'diag.link': 'link',
    'diag.rendezvous': 'bridge (on the Mac)',
    'diag.opened': 'opened in {ms} ms with {bytes} bytes of handshake',

    'remote.off': 'off',
    'remote.missing_url': 'not set',
    'remote.bad_url': 'address must start with https://',
    'remote.connected': 'connected',
    'remote.connected_n': '{n} phones connected',
    'remote.listening_error': 'listening · {detail}',
    'remote.waiting_first': 'waiting for the first phone',
    'remote.listening': 'listening',
    'remote.no_shared_memory': 'the bridge has no shared memory: meeting from different networks may fail',
  };

  const IT = {
    'doc.title': 'Riflesso — le tue chat Claude',
    'doc.manifest': 'Riflesso — Claude sul telefono',
    'doc.manifest_desc': 'Le tue conversazioni Claude, sul telefono.',

    'pair.sub': 'Le tue conversazioni Claude, dal telefono.',
    'pair.hint': 'Apri Riflesso sul Mac e scrivi le otto cifre che vedi. Se inquadri il QR lì accanto, questa schermata la salti.',
    'pair.button': 'Collega',
    'pair.connecting': 'Collego…',
    'pair.need_digits': 'Servono {n} cifre.',
    'pair.rejected': 'Codice rifiutato.',

    'list.chats': 'Chat',
    'list.routines': 'Routine',
    'list.search_chats': 'Cerca fra titoli e messaggi…',
    'list.search_routines': 'Cerca fra le routine…',
    'list.one_chat': '1 conversazione',
    'list.n_chats': '{n} conversazioni',
    'list.one_routine': '1 routine',
    'list.n_routines': '{n} routine',
    'list.empty_chat': 'Nessuna conversazione trovata.',
    'list.pinned': 'Fissato',
    'list.ungrouped': 'Non raggruppato',
    'list.empty_routine': 'Nessuna routine trovata.',
    'list.loading': 'Sto leggendo le conversazioni dal Mac…',
    'list.you': 'Tu: ',
    'list.no_transcript': 'testo non più sul Mac',
    'list.now': 'ora',
    'list.yesterday': 'ieri',
    'list.today': 'oggi',

    'chat.conversation': 'Conversazione',
    'chat.opening': 'apro…',
    'chat.cant_open': 'Non si apre.',
    'chat.working': 'Sta lavorando',
    'chat.model': 'Modello',
    'chat.load_more': 'Carica messaggi precedenti',
    'chat.loading': 'carico…',
    'chat.placeholder': 'Scrivi in questa chat…',
    'chat.claude_working': 'Claude sta lavorando…',
    'chat.failed': 'Non è riuscito.',
    'chat.thinking': 'ragionamento',
    'chat.cmd_out': 'esito del comando',
    'chat.document': 'documento',
    'chat.image': 'immagine',
    'chat.image_bad': 'immagine non leggibile',
    'chat.tool_pending': 'senza esito: la risposta non è ancora nel file.',
    'chat.tool_result': 'esito',
    'chat.tool_empty': 'nessun dettaglio.',
    'chat.commands': 'comandi',
    'chat.tools': 'strumenti',
    'chat.copy': 'copia',
    'chat.copied': 'copiato',
    'chat.code': 'codice',
    'chat.chars': '{n} caratteri',
    'chat.tokens': 'token',
    'chat.photo': 'foto',
    'chat.file_too_big': 'Il file è troppo grande: al massimo {max}. Non ho mandato niente.',
    'chat.upload_failed': 'L’allegato non è arrivato al Mac: non ho mandato niente.',

    'model.sheet': 'Modello e impegno',
    'model.effort': 'Impegno',
    'model.note.fable': 'il più capace',
    'model.note.opus': 'il cavallo di battaglia',
    'model.note.sonnet': 'equilibrato',
    'model.note.opus48': 'generazione precedente',
    'model.note.haiku': 'il più veloce',
    'effort.low': 'Basso',
    'effort.medium': 'Medio',
    'effort.high': 'Alto',
    'effort.extra': 'Extra',
    'effort.max': 'Max',
    'effort.ultracode': 'Ultracode',
    'effort.haiku': 'Haiku non ha l’impegno: non c’è niente da regolare. Ce l’hanno Fable, Opus e Sonnet.',
    'effort.help': 'L’impegno non ha un comando: l’app sposta il cursore dentro Claude sul Mac, come faresti tu. Vale per questa conversazione, e se il Mac è in uso l’app aspetta invece di toccarlo.',
    'effort.moving': 'Sposto l’impegno su {name}…',
    'model.switching': 'Cambio modello a {name}: lo chiedo a Claude sul Mac…',

    'settings.title': 'Impostazioni',
    'settings.language': 'Lingua',
    'settings.input': 'Comandi verso il Mac',
    'settings.hybrid': 'Ibrida (consigliata)',
    'settings.direct': 'Solo diretta',
    'settings.global': 'Solo globale',
    'settings.enter': 'Invio con Invio',
    'settings.routines': 'Routine programmate',
    'settings.back_chats': 'Torna alle chat',
    'settings.forget': 'Dimentica questo dispositivo',
    'settings.blurb': 'Scrivere da qui passa <b>dentro Claude sul Mac</b>: il messaggio viene consegnato nella stessa conversazione e inviato da lì, quindi lo vedi comparire anche sul Mac. Se al Mac c’è qualcuno che lo sta usando, l’invio aspetta invece di scrivergli sotto le mani.',
    'settings.cli': 'Il comando <code>claude</code> non si trova su questo Mac: le chat si leggono, ma non si può rispondere.',

    'aria.back_list': 'Torna alle chat',
    'aria.settings': 'Impostazioni',
    'aria.back': 'Indietro',
    'aria.model': 'Modello di questa chat',
    'aria.stop': 'Ferma',
    'aria.send': 'Invia',
    'aria.model_effort': '{model}, impegno {effort}. Tocca per cambiare.',
    'aria.attach': 'Allega una foto o un file',
    'aria.drop_file': 'Togli l’allegato',
    'aria.mic': 'Detta un messaggio',
    'aria.mic_stop': 'Ferma la registrazione',

    'voice.recording': 'Sto registrando… tocca di nuovo il microfono per fermare.',
    'voice.transcribing': 'Trascrivo sul Mac…',
    'voice.empty': 'Non ho sentito niente: riprova, più vicino al telefono.',
    'voice.no_mic': 'Il microfono non è permesso: concedilo a questa pagina (Safari: aA → Impostazioni sito → Microfono) e riprova.',
    'voice.unsupported': 'Questo browser non registra in un formato che il Mac legge. Usa la dettatura della tastiera: scrive nello stesso riquadro.',
    'voice.failed': 'Non sono riuscito a trascrivere: non ho mandato niente. La dettatura della tastiera funziona lo stesso nel riquadro.',
    'voice.too_long': 'Registrazione fermata dopo {min} minuti: è il massimo per un messaggio.',
    'settings.dictation': '<b>Dettatura.</b> Il tasto del microfono registra sul telefono; il Mac lo trasforma in testo — sul Mac stesso, niente esce di lì — e lo mette nel riquadro, dove lo rileggi prima di mandarlo. Anche la dettatura della tastiera scrive nello stesso riquadro, dappertutto.',
    'settings.dictation_home': '<b>Dettatura.</b> Sulla rete di casa (http) la pagina non può usare il microfono, quindi qui il tasto non c’è: usa la dettatura della tastiera, che scrive nello stesso riquadro. Dal ponte (https) il tasto c’è.',

    'status.connected': 'collegato',
    'status.disconnected': 'disconnesso',
    'status.net_error': 'errore di rete',
    'status.dropped': 'collegamento caduto',
    'status.connecting': 'mi collego…',
    'status.offline': 'non collegato',

    'road.home': 'rete di casa · {host}',
    'road.direct': 'diretta · {host}',
    'road.bridge_home': 'ponte · in casa ({host})',
    'road.bridge_away': 'ponte · fuori casa ({host})',
    'road.bridge_relay': 'ponte · rimbalzo ({host})',
    'road.bridge_connecting': 'ponte · mi collego… ({host})',
    'road.bridge_down': 'ponte · non collegato ({host})',
    'road.label': 'Strada: {road}',

    'net.relay': 'rimbalzo',
    'net.looking': 'Cerco il Mac…',
    'net.waiting_mac': 'Aspetto il Mac…',
    'net.linking': 'Mi collego al Mac…',
    'net.closed': 'Collegamento chiuso',
    'net.unreachable_home': 'Il Mac non risponde sulla rete di casa. Il telefono è sullo stesso Wi-Fi, e Riflesso è aperto sul Mac?',
    'net.unreachable': 'Il Mac non risponde dietro questo indirizzo. Controlla che Riflesso sia aperto sul Mac e che l’indirizzo porti ancora lì.',
    'net.unreachable_bridge': 'Il ponte non risponde. Controlla la connessione di questo telefono, o che il ponte sia acceso.',
    'net.failed': 'Collegamento non riuscito: {detail}',

    'err.senza-segreto': 'Manca il segreto dell’incontro. Scrivi il codice nel pannello di Riflesso.',
    'err.senza-gettone': 'Questo telefono non è ancora collegato al Mac: scrivi il codice che vedi nel pannello di Riflesso.',
    'err.senza-codice': 'Serve il codice che il Mac mostra nel suo pannello.',
    'err.senza-incontro': 'Questo telefono è già collegato, ma deve riscrivere il codice una volta: sul Mac ne trovi uno buono.',
    'err.nessuna-risposta': 'Il Mac non risponde attraverso il ponte. È una di quattro cose: il Mac è spento o addormentato; Riflesso non è aperto; sul Mac è scritto un indirizzo del ponte diverso da questo; oppure il Mac ha rigenerato la sua stanza sul ponte e questo telefono bussa a quella vecchia — in quel caso inquadra di nuovo il QR sul Mac.',
    'err.risposta-non-mia': 'Risposta non riconosciuta dal Mac: riprovo.',
    'err.risposta-vecchia': 'Risposta scaduta: riprovo.',
    'err.impronta-diversa': 'L’impronta del Mac non corrisponde: mi fermo invece di collegarmi a qualcun altro.',
    'err.niente-strada': 'Il ponte c’è, ma da qui il collegamento diretto col Mac non si apre. Succede dietro qualche rete aziendale che blocca tutto: riprova più tardi o da un’altra connessione.',
    'err.troppo-in-fretta': 'Troppi tentativi di fila verso il ponte: aspetta un minuto e riprova.',
    'err.caduto': 'Collegamento caduto',
    'err.il Mac non ha risposto': 'Il Mac non ha risposto',

    'n.delivering': 'Lo consegno a Claude sul Mac…',
    'n.conversation_gone': 'Non trovo più questa conversazione fra quelle del Mac.',
    'n.conversation_in_use': 'Questa conversazione è in uso adesso sul Mac. Scrivere qui dentro in due spezzerebbe il filo: chiudila sul Mac o riprova fra qualche secondo.',
    'n.live_locked': 'Questa conversazione è aperta sul Mac in questo momento: da qui non si può scrivere finché è in uso.',
    'n.fallback_unknown': 'Questa conversazione non è fra quelle che Claude ha aperto sul Mac: rispondo con il motore di riserva. Sul Mac si vedrà riaprendola.',
    'n.fallback_closed': 'Claude Desktop non è aperto sul Mac: rispondo senza di lui. Sul Mac riapri la conversazione per vederla.',
    'n.desktop_still_working': 'Il Desktop sta ancora lavorando: la risposta continua ad arrivare qui.',
    'n.transcript_missing': 'Il testo di questa conversazione non è sul Mac: non si può continuarla.',
    'n.transcript_gone': 'Il testo di questa conversazione non è più sul Mac, quindi non si può aprire né continuare.',
    'n.unknown_model': 'Modello non riconosciuto: non ho mandato niente.',
    'n.model_needs_desktop': 'Il modello si cambia solo con Claude aperto sul Mac.',
    'n.effort_invalid': 'Livello di impegno non valido.',
    'n.effort_needs_desktop': 'L’impegno si cambia solo con Claude aperto sul Mac.',
    'n.moving_effort': 'Sposto l’impegno sul Mac…',
    'n.unknown_to_desktop': 'Questa conversazione non è fra quelle che il Desktop conosce: aprila una volta sul Mac.',
    'n.effort_unsupported': '{model} non ha l’impegno: ce l’hanno Fable, Opus e Sonnet.',
    'n.effort_changed': 'Impegno cambiato.',
    'n.desktop_not_running': 'Claude non è aperto sul Mac.',
    'n.queued': 'In coda: Claude sta ancora rispondendo in questa chat.',
    'n.cli_model_fallback': 'Il modello della sessione non è utilizzabile dal CLI: rispondo col predefinito.',
    'n.stopped': 'Interrotto.',
    'n.mac_busy_wait': 'Al Mac c’è qualcuno che lo sta usando: aspetto un momento.',
    'n.mac_in_use': 'Il Mac è in uso proprio adesso e per consegnare dovrei portare Claude davanti: non ti rubo la scrivania. Riprova fra poco.',
    'n.unknown_session_id': 'Non so con quale identificativo il Desktop conosce questa conversazione.',
    'n.bad_conversation_url': 'Indirizzo della conversazione non valido.',
    'n.sidebar_ambiguous': 'Sul Desktop non trovo una riga sola per «{title}» nella barra laterale, e per questa conversazione il collegamento diretto creerebbe un doppione. Aprila tu sul Mac e riprova.',
    'n.desktop_didnt_switch': 'Il Desktop non è passato a questa conversazione: non scrivo alla cieca.',
    'n.effort_wrong_chat': 'Il Desktop non è su questa conversazione: non tocco l’impegno.',
    'n.effort_picker_missing': 'Non trovo il selettore dell’impegno nella finestra di Claude.',
    'n.effort_panel_closed': 'Il pannello dell’impegno non si è aperto: non ho cambiato niente.',
    'n.effort_switched_away': 'Mentre cambiavo l’impegno il Desktop è passato a un’altra conversazione: controlla, potrei averlo cambiato lì.',
    'n.effort_slider_stuck': 'Il cursore dell’impegno non si è spostato.',
    'n.delivery_in_flight': 'C’è già una consegna in corso per questa conversazione.',
    'n.composer_unreadable': 'Non vedo il riquadro di scrittura del Desktop — forse Claude sta mostrando altro. Non ho scritto niente: riprova fra un istante.',
    'n.composer_not_empty': 'Sul Mac c’è già del testo nel riquadro di Claude. Non lo tocco: svuotalo e riprova.',
    'n.composer_unfocused': 'Non riesco a mettere il fuoco nel riquadro di Claude sul Mac.',
    'n.conversation_switched': 'Il Desktop ha cambiato conversazione proprio adesso: non scrivo.',
    'n.text_not_delivered': 'Non sono riuscito a consegnare il testo al Desktop. Il riquadro sul Mac è rimasto vuoto: non ho mandato niente.',
    'n.text_mismatch': 'Nel riquadro del Desktop è finito un testo diverso da quello che hai scritto: ho pulito e non ho mandato niente.',
    'n.conversation_changed_while_writing': 'Mentre scrivevo, sul Mac è cambiata la conversazione aperta. Ho tolto il testo e non ho mandato niente: riprova.',
    'n.composer_lost_message': 'Il riquadro del Desktop non contiene più il messaggio: non ho mandato niente.',
    'n.send_rejected': 'Il Desktop non ha accettato l’invio: il testo era ancora nel riquadro, l’ho tolto. Non è partito niente.',
    'n.composer_has_attachment': 'Nel riquadro di Claude sul Mac c’è già un allegato ({name}). Non lo tocco: toglilo e riprova.',
    'n.attach_failed': 'Non sono riuscito ad allegare {name} dentro Claude sul Mac. Non ho mandato niente.',
    'n.attach_mismatch': 'Nel riquadro di Claude è finito un allegato diverso: l’ho tolto e non ho mandato niente.',
    'n.attachment_needs_desktop': 'Gli allegati passano da Claude sul Mac, e questa conversazione lì non è aperta. Manda il testo da solo, oppure aprila sul Mac.',
    'n.upload_missing': 'L’allegato non è arrivato tutto: non ho mandato niente, riprova ad allegarlo.',
    'n.upload_too_big': 'Il file è troppo grande: al massimo {max}.',
    'n.upload_unknown': 'Il caricamento si è perso per strada: riprova ad allegare il file.',
    'n.upload_out_of_order': 'I pezzi dell’allegato sono arrivati fuori ordine: riprova.',
    'n.upload_failed': 'Non sono riuscito a ricevere l’allegato sul Mac.',
    'n.transcribe_unsupported_os': 'Il Mac non può trascrivere: serve macOS 26 o più recente. Usa la dettatura della tastiera.',
    'n.transcribe_no_language': 'Il Mac non ha il modello vocale per {detail}. Usa la dettatura della tastiera.',
    'n.transcribe_installing': 'Il Mac sta scaricando il modello vocale per {detail}: riprova fra un minuto.',
    'n.transcribe_bad_audio': 'Il Mac non è riuscito a leggere la registrazione. Non ho mandato niente.',
    'n.transcribe_failed': 'La trascrizione sul Mac non è riuscita: {detail}',
    'n.message_too_long': 'Messaggio troppo lungo per essere consegnato al CLI.',
    'n.cli_missing': 'Non trovo il comando claude su questo Mac. L’app usa il CLI ufficiale: senza quello non può inviare.',
    'n.folder_gone': 'La cartella di questa chat non esiste più: {cwd}',
    'n.cli_start_failed': 'Non riesco ad avviare il CLI: {detail}',
    'n.cli_error': '{detail}',
    'n.cli_error_generic': 'Il CLI ha segnalato un errore.',
    'n.cli_silent': 'Il CLI è uscito senza rispondere (codice {status}).',
    'n.waiting_mac_busy': 'Questa chat è in uso sul Mac in questo momento: aspetto che finisca.',
    'n.sending_anyway': 'Il Mac sta ancora lavorando in questa chat: invio comunque, in coda.',
    'n.permissions_blocked': 'Bloccati dai permessi: {list}. La risposta potrebbe essere incompleta.',
    'n.pin_wrong': 'Codice errato',
    'n.pin_expired': 'Codice scaduto: sul Mac ne trovi uno nuovo',
    'n.pin_locked': 'Troppi tentativi: il codice è stato rigenerato. Guarda il Mac e riprova fra {seconds}s',
    'n.pin_forgotten': 'Il Mac non riconosce più questo telefono: scrivi il codice che vedi nel suo pannello.',
    'n.signed_out': 'Telefono scollegato. Per rientrare, il codice sul Mac.',
    'n.remote_https': 'Il ponte deve essere un indirizzo https://',
    'n.chat_unspecified': 'Chat non indicata',
    'n.unauthorized': 'Non autorizzato',
    'n.scheduled_task': 'attività programmata · {name}',
    'n.background_done': 'un lavoro in sottofondo è terminato',
    'n.interrupted': 'interrotto',

    'diag.version': 'versione',
    'diag.cli': 'comando claude',
    'diag.found': 'trovato',
    'diag.missing': 'NON TROVATO',
    'diag.ax': 'accessibilità',
    'diag.ax_ok': 'concessa',
    'diag.ax_no': 'MANCANTE — lo specchio non riceve comandi',
    'diag.devices': 'dispositivi accoppiati',
    'diag.link': 'collegamento',
    'diag.rendezvous': 'ponte (sul Mac)',
    'diag.opened': 'aperto in {ms} ms con {bytes} byte di appuntamento',

    'remote.off': 'spento',
    'remote.missing_url': 'non impostato',
    'remote.bad_url': 'l’indirizzo deve iniziare per https://',
    'remote.connected': 'collegato',
    'remote.connected_n': 'collegati {n} telefoni',
    'remote.listening_error': 'in ascolto · {detail}',
    'remote.waiting_first': 'in attesa del primo telefono',
    'remote.listening': 'in ascolto',
    'remote.no_shared_memory': 'il ponte non ha memoria condivisa: da reti diverse l’incontro può non riuscire',
  };

  const TABLES = { en: EN, it: IT };
  const listeners = [];

  function proposed() {
    const nav = String((typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || '').toLowerCase();
    return nav.indexOf('it') === 0 ? 'it' : 'en';
  }

  function read() {
    try {
      const s = localStorage.getItem(STORE);
      if (s === 'en' || s === 'it') return s;
    } catch (e) {}
    const v = proposed();
    try { localStorage.setItem(STORE, v); } catch (e) {}
    return v;
  }

  let lang = 'en';

  function fill(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
  }

  function has(key) {
    return !!(TABLES[lang] && TABLES[lang][key]) || !!EN[key];
  }

  function t(key, vars) {
    const table = TABLES[lang] || EN;
    const s = table[key] || EN[key] || key;
    return fill(s, vars);
  }

  function notice(code, data) {
    if (!code) return '';
    data = data || {};
    if (code === 'cli_error' && !String(data.detail || '').trim()) return t('n.cli_error_generic');
    const key = 'n.' + code;
    if (has(key)) return t(key, data);
    if (data.detail) return String(data.detail);
    if (data.text) return String(data.text);
    return code;
  }

  function remote(code, vars) {
    if (!code) return '';
    const key = 'remote.' + code;
    if (has(key)) return t(key, vars);
    return code;
  }

  function apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
    document.title = t('doc.title');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    const sel = document.getElementById('langSel');
    if (sel && sel.value !== lang) sel.value = lang;
  }

  function set(next) {
    const v = next === 'it' ? 'it' : 'en';
    if (v === lang) { apply(); return; }
    lang = v;
    try { localStorage.setItem(STORE, lang); } catch (e) {}
    apply();
    listeners.forEach((fn) => { try { fn(lang); } catch (e) {} });
  }

  function boot() {
    lang = read();
    apply();
  }

  const I18n = {
    t, notice, remote, has, apply, set, boot,
    locale: () => (lang === 'it' ? 'it-IT' : 'en-US'),
    get: () => lang,
    onChange: (fn) => { listeners.push(fn); },
  };

  global.I18n = I18n;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
