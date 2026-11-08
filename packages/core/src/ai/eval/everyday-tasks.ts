/**
 * Everyday requests people make of Fabrix, each with the tools the job needs and the starter skill that fits it (or
 * none). The tests check, for every request, that a small model is given those tools and that skill, so a change to
 * the tool short list, the skills or the tools themselves cannot quietly leave Fabrix without what a job needs. The
 * same list is a starting point for scoring models on these jobs.
 */
export interface EverydayTask {
  ask: string;
  /** Tools the job needs; Windows-only ones are checked on Windows. */
  tools: string[];
  skill: string | null;
}

export const EVERYDAY_TASKS: EverydayTask[] = [
  { ask: 'Create a project called Garden and add a note about tomatoes to it', tools: ['workspace.create_project', 'workspace.create_note'], skill: null },
  { ask: 'My Wi-Fi keeps dropping in the bedroom', tools: ['net.wifi_channels', 'net.ping'], skill: 'Slow or dropping Wi-Fi' },
  { ask: 'My disk is almost full, help me free up some space', tools: ['pc.storage_report', 'pc.space_hogs', 'pc.clean_temp'], skill: 'Free up disk space' },
  { ask: 'Why is my computer so slow today?', tools: ['pc.live_status', 'system.processes', 'fbrx.doctor'], skill: 'Computer feels slow' },
  { ask: 'What devices are on my network?', tools: ['net.scan_lan'], skill: "What's on my network" },
  { ask: 'What is on my calendar today?', tools: ['calendar.agenda'], skill: 'Plan my day' },
  { ask: 'Remind me to call the dentist tomorrow', tools: ['workspace.add_task', 'calendar.create_event'], skill: null },
  { ask: "Make a PDF report of this week's tasks", tools: ['docs.create', 'workspace.list_tasks'], skill: null },
  { ask: 'Draw a storybook picture of a mouse knight fighting a giant', tools: ['image.compose'], skill: null },
  { ask: 'Is my computer safe? I think I clicked a bad link', tools: ['shield.status', 'net.check_link', 'pc.security_status'], skill: 'Security check-up' },
  { ask: 'Ping 8.8.8.8 and trace the route to it', tools: ['net.ping', 'net.traceroute'], skill: null },
  { ask: 'What is my IP?', tools: ['net.ip_address'], skill: null },
  { ask: 'What did we decide about the VPN last week? You said something earlier', tools: ['memory.search_chats'], skill: null },
  { ask: 'Save how you did that as a skill for next time', tools: ['skills.save'], skill: null },
];
