export type ParsedParkAlert = Readonly<{ title: string; published: string; excerpt: string; url: string }>;
export declare const parseActiveAlerts: (html: string) => ParsedParkAlert[];
