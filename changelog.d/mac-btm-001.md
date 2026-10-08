## macOS background tasks

HQ.app includes a versioned launcher protocol for HQ CLI LaunchAgents, writes its autostart plist only when its bytes change, and attributes the item to the bundle identifier read from its Info.plist.
