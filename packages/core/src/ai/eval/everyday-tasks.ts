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
  /** Tools it must not be offered: words in the request that are not what it asks for (a note's subject, text to save). */
  never?: string[];
}

export const EVERYDAY_TASKS: EverydayTask[] = [
  { ask: 'Create a project called Garden and add a note about tomatoes to it', tools: ['workspace.create_project', 'workspace.create_note'], skill: null },
  { ask: 'My Wi-Fi keeps dropping in the bedroom', tools: ['net.wifi_channels', 'net.ping'], skill: 'Slow or dropping Wi-Fi' },
  { ask: 'My disk is almost full, help me free up some space', tools: ['pc.storage_report', 'pc.space_hogs', 'pc.clean_temp'], skill: 'Free up disk space' },
  { ask: 'Why is my computer so slow today?', tools: ['pc.live_status', 'system.processes', 'fbrx.doctor'], skill: 'Computer feels slow' },
  { ask: 'What devices are on my network?', tools: ['net.scan_lan'], skill: "What's on my network" },
  // Something is broken: the full check first, then the tools for where it breaks.
  { ask: 'Why is my network not working?', tools: ['net.diagnose', 'net.traceroute', 'net.dns_lookup'], skill: 'Troubleshoot the network' },
  { ask: "The internet is down and nothing will load", tools: ['net.diagnose'], skill: 'Troubleshoot the network' },
  { ask: "I can't get online", tools: ['net.diagnose'], skill: 'Troubleshoot the network' },
  { ask: "Websites won't load but Wi-Fi says connected", tools: ['net.diagnose', 'net.wifi_channels'], skill: 'Troubleshoot the network' },
  { ask: 'shop.example.org will not load for me', tools: ['net.diagnose', 'net.check_link'], skill: 'Troubleshoot the network' },
  { ask: 'My printer is not printing anything', tools: ['pc.devices', 'net.ping', 'net.port_check', 'pc.run_fix'], skill: 'Printer not printing' },
  { ask: 'There is no sound coming out of my speakers', tools: ['pc.devices', 'pc.event_errors'], skill: 'No sound or microphone' },
  { ask: "People can't hear me on calls, is my microphone broken?", tools: ['pc.devices'], skill: 'No sound or microphone' },
  { ask: "My Bluetooth headphones won't pair", tools: ['pc.devices'], skill: 'Bluetooth device will not connect' },
  { ask: 'My second monitor stays black', tools: ['pc.devices'], skill: 'Screen or second display problems' },
  { ask: 'Excel keeps crashing when I open a file', tools: ['pc.event_errors', 'system.processes', 'pc.storage_report'], skill: 'An app keeps crashing' },
  { ask: 'Windows updates are stuck and keep failing', tools: ['pc.pending_updates', 'pc.storage_report', 'pc.run_fix'], skill: 'Updates stuck or failing' },
  { ask: "My work VPN won't connect", tools: ['net.diagnose', 'net.port_check'], skill: 'VPN will not connect' },
  { ask: 'What is on my calendar today?', tools: ['calendar.agenda'], skill: 'Plan my day' },
  { ask: 'Remind me to call the dentist tomorrow', tools: ['workspace.add_task', 'calendar.create_event'], skill: null },
  { ask: "Make a PDF report of this week's tasks", tools: ['docs.create', 'workspace.list_tasks'], skill: null },
  { ask: 'Draw a storybook picture of a mouse knight fighting a giant', tools: ['image.compose'], skill: null },
  { ask: 'Is my computer safe? I think I clicked a bad link', tools: ['shield.status', 'net.check_link', 'pc.security_status'], skill: 'Security check-up' },
  { ask: 'Ping 8.8.8.8 and trace the route to it', tools: ['net.ping', 'net.traceroute'], skill: null },
  { ask: 'What is my IP?', tools: ['net.ip_address'], skill: null },
  { ask: 'What did we decide about the VPN last week? You said something earlier', tools: ['memory.search_chats'], skill: null },
  { ask: 'Save how you did that as a skill for next time', tools: ['skills.save'], skill: null },
  // From the Noah eval on 2.3.2: the person's own notes and tasks, where a word in them is not the request.
  { ask: 'My notes about the router are a mess. Can you tidy them up?', tools: ['workspace.search_notes', 'workspace.create_note', 'workspace.append_note'], skill: null, never: ['kit.check_the_internet', 'net.ip_address'] },
  { ask: 'Check my notes: who serviced the boiler last time, and when is the next service due?', tools: ['workspace.search_notes'], skill: null, never: ['kit.time_since_restart'] },
  { ask: 'Summarize my note about the router.', tools: ['workspace.search_notes'], skill: null, never: ['kit.check_the_internet', 'net.ip_address'] },
  { ask: 'Make a PDF report of my open tasks.', tools: ['docs.create', 'workspace.list_tasks'], skill: null, never: ['kit.is_a_port_open', 'kit.open_connections'] },
  { ask: 'Email my list of open tasks to my manager.', tools: ['workspace.list_tasks'], skill: null, never: ['kit.is_a_port_open', 'kit.open_connections'] },
  { ask: 'What tasks do I have open?', tools: ['workspace.list_tasks'], skill: null, never: ['kit.is_a_port_open', 'kit.open_connections'] },
  { ask: "Save this as a snippet called 'disk usage': du -sh * | sort -h", tools: ['workspace.save_snippet'], skill: null, never: ['kit.disk_space'] },
  { ask: 'Save a text file called shopping.txt in my workspace with: milk, eggs, bread.', tools: ['fs.write_file'], skill: null, never: ['kit.disk_space'] },
];
