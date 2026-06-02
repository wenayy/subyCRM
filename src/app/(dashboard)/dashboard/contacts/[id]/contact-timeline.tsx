// src/app/(dashboard)/dashboard/contacts/[id]/contact-timeline.tsx
"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { contactsApi, remindersApi } from "@/lib/api";
import { UnifiedTimeline } from "@/app/(dashboard)/dashboard/contacts/[id]/contact-detail-view"; // re‑use existing component
import { Contact, Reminder, Interaction } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ContactTimelinePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();

  const [contact, setContact] = useState<Contact | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  // Load static contact & reminders (same logic as ContactDetailView)
  useEffect(() => {
    contactsApi
      .getById(id)
      .then(setContact)
      .catch(() => {})
      .finally(() => setLoading(false));
    remindersApi.getAll().then((all) => {
      setReminders(all.filter((r) => r.contactId === id));
    });
  }, [id]);

  // SWR for timeline interactions (paginated)
  const { data: interactions, error } = useSWR<Interaction[]>(
    `/api/contacts/${id}/timeline?limit=30&offset=0`,
    fetcher
  );

  // Merge fetched interactions into contact when available
  useEffect(() => {
    if (interactions && contact) {
      setContact({ ...contact, interactions });
    }
  }, [interactions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <span className="inline-block size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" style={{ width: 20, height: 20, color: "var(--t3)" }} />
      </div>
    );
  }

  if (!contact) {
    return <div className="py-12 px-6 text-center text-muted-foreground text-sm">Contact not found</div>;
  }

  // Render the unified timeline. Note: note/reminder handling is disabled for this view.
  return (
    <div className="flex flex-col gap-6 w-full p-6">
      <button onClick={() => router.back()} className="self-start text-sm text-primary hover:underline">← Back to Contact</button>
      <UnifiedTimeline
        contact={contact}
        reminders={reminders}
        noteText=""
        setNoteText={() => {}}
        addingNote={false}
        onAddNote={() => {}}
        onDeleteNote={() => {}}
        reminderContent=""
        setReminderContent={() => {}}
        reminderDate=""
        setReminderDate={() => {}}
        addingReminder={false}
        onAddReminder={() => {}}
        onReminderAction={() => {}}
        onDeleteReminder={() => {}}
      />
    </div>
  );
}
