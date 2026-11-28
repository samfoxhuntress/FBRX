import { AttachmentTray, Button, CreatedFiles as SharedCreatedFiles, MessageAttachments as SharedMessageAttachments, base64, fitImage, useAttachments as useSharedAttachments } from '@fbrx/ui';
import type { AttachmentInfo, CreatedFile } from '@fbrx/shared';
import { bridge, call } from './client';

/** Files in Fabrix's chats on this computer: the UI kit's, read through the core, opened in their folders. */
export { AttachmentTray, base64, fitImage };

export const useAttachments = () => useSharedAttachments({ add: (p) => call('ai.attachments.add', p), remove: (id) => call('ai.attachments.remove', { id }) });

/** What a sent message had attached; a file chip shows the file in its folder. */
export function MessageAttachments({ files }: { files: AttachmentInfo[] }) {
  return <SharedMessageAttachments files={files} read={(id) => call('ai.attachments.read', { id })} open={{ title: (a) => `Show ${a.name} in its folder`, run: (a) => void bridge.reveal?.(a.path) }} />;
}

/** Files a step made, each with Open and Show in folder. */
export function CreatedFiles({ files }: { files: CreatedFile[] }) {
  return (
    <SharedCreatedFiles
      files={files}
      preview={(path) => call('ai.files.preview', { path })}
      actions={(f) => (
        <>
          {bridge.openFile && (
            <Button size="sm" variant="ghost" icon="external" onClick={() => void bridge.openFile?.(f.path)}>
              Open
            </Button>
          )}
          {bridge.reveal && <Button size="sm" variant="ghost" icon="folder" aria-label={`Show ${f.name} in its folder`} title="Show in its folder" onClick={() => void bridge.reveal?.(f.path)} />}
        </>
      )}
    />
  );
}
