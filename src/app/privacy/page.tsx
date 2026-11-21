import Link from "next/link";

export const metadata = { title: "Privacy — Mesa" };

export default function PrivacyPage() {
  return (
    <main className="page">
      <article className="container stack-lg">
        <Link href="/" className="small" style={{ color: "var(--accent)" }}>
          ← Mesa
        </Link>
        <h1 className="display h-lg">How your voice is handled</h1>

        <section className="stack">
          <h2 className="display h-md">What happens while your mic is on</h2>
          <p className="muted">
            Your phone sends your microphone audio over an encrypted WebRTC connection to <strong>LiveKit Cloud</strong>,
            which delivers it to the other people in your current conversation and to the interpreter service. The
            interpreter streams it to <strong>Google Gemini Live Translate</strong> (and, if the gathering uses it as a
            backup, <strong>OpenAI</strong>) and sends back translated speech and captions. So that names come out
            right, the interpreter also tells Google the display names of the people in your conversation. Those providers process
            the audio under their own API terms; Google&apos;s and OpenAI&apos;s paid APIs state that API data is not
            used to train their models, but they may process it outside the EU.
          </p>
        </section>

        <section className="stack">
          <h2 className="display h-md">What Mesa keeps</h2>
          <ul className="muted" style={{ paddingLeft: 20 }}>
            <li>No audio recordings and no transcripts. Captions exist only in the browsers of the people in the conversation.</li>
            <li>While the gathering is open: names, chosen languages, which conversation each person is in, invitations.</li>
            <li>When the host ends the gathering (or it expires) names, groups and invitations are deleted.</li>
            <li>
              Only if you choose <strong>Remember me on this phone</strong>: your name, your languages, when you agreed to
              live AI interpretation, and your saved tables (their names and who is at them) — until you tap{" "}
              <strong>Forget me</strong>, or after 400 days without using Mesa.
            </li>
            <li>Anonymous usage numbers (minutes of interpreted audio, estimated cost, delay measurements) are kept for spending limits.</li>
            <li>
              Anonymous quality numbers, for 30 days, to find and fix problems: per minute, how long translations took,
              which language the interpreter thought it heard (counts only), reconnections, and how often a microphone
              was muted for picking up someone else. Never names, words or audio.
            </li>
            <li>Security logs without names or content (e.g. &ldquo;someone tried to join with an invalid link&rdquo;) for 30 days.</li>
          </ul>
        </section>

        <section className="stack">
          <h2 className="display h-md">Remembered on this phone</h2>
          <p className="muted">
            There is no email, phone number or password. Your phone keeps a long random key in a secure cookie that
            only Mesa&apos;s server can read; the server stores just a fingerprint (hash) of that key. People who share
            a saved table with you see your name, your language and whether you are at the table right now — nobody
            else does. Whoever looks after a table can remove someone; that also replaces the table&apos;s link.
            Leaving a table, or &ldquo;Forget me&rdquo; (on Mesa&apos;s home screen, under your name), deletes your
            place for good.
          </p>
        </section>

        <section className="stack">
          <h2 className="display h-md">Private conversations</h2>
          <p className="muted">
            Each conversation group uses its own media room. The server only gives you access to the room you are in,
            and removes you from a room when you leave it. People outside a private conversation cannot receive its
            audio or captions. That privacy is between guests — it does not hide anything from the providers above —
            and it cannot stop a microphone from physically picking up someone sitting nearby.
          </p>
        </section>

        <section className="stack">
          <h2 className="display h-md">Voices</h2>
          <p className="muted">
            The interpreter imitates the general character of each speaker&apos;s voice on its own, live. Mesa does not
            create voice clones, and the translated voice can sometimes sound different from the speaker.
          </p>
        </section>
      </article>
    </main>
  );
}
