export interface ClientConfig {
  client_id: string;
  nom: string;
  nom_court: string;
  secteurs: string[];
  sujet_instit: string;
  acteurs_suivis: string[];
  mots_cles: string[];
  slack_channel_id: string;
  notion_hub_id?: string;
}

export interface ParsedEmail {
  num: number;
  date: string;
  sender: string;
  subject: string;
  body: string;
}

export interface TaggedEmail extends ParsedEmail {
  matched_clients: string[];
  matched_keywords: string[];
}

export interface ClientSignal {
  titre: string;
  niveau: 'critique' | 'fort' | 'moyen' | 'faible';
  description: string;
  impact: string;
  recommandation: string;
  email_num?: number;
}

export interface ParliamentData {
  client_id: string;
  date: string;
  run_at_utc: string;
  has_signals: boolean;
  signal_count: number;
  slack_text: string;
}

export interface ClientBulletin {
  client_id: string;
  nom_court: string;
  date: string;
  synthese: string;
  signaux: ClientSignal[];
  agenda: string[];
  ras: boolean;
  emails_count: number;
  parliament?: ParliamentData | null;
}

export interface VeilleRunResult {
  date: string;
  total_emails: number;
  bulletins: ClientBulletin[];
  errors: string[];
}
