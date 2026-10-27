import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectSchema, type Project } from '../shared/project.js';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(directory: string) {
    this.file = path.join(directory, 'project.json');
  }
  async read() {
    try {
      const raw = await readPrivate(this.file, 32000);
      return {
        project: projectSchema.parse(JSON.parse(raw)),
        base: createHash('sha256').update(raw).digest('hex'),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { project: projectSchema.parse({}), base: '' };
      throw new StudioError(
        'Brief privé invalide ou inaccessible. Original préservé ; le mode tokens reste disponible.',
        500,
      );
    }
  }
  save(base: string, project: Project) {
    const work = this.queue.then(async () => {
      const current = await this.read();
      if (current.base !== base)
        throw new StudioError(
          'Brief modifié dans un autre onglet. Rechargez le brief avant de le modifier.',
          409,
        );
      const validated = projectSchema.parse(project);
      if (current.base)
        await atomicWrite(
          this.file + '.previous',
          JSON.stringify(current.project, null, 2) + '\n',
        );
      await atomicWrite(this.file, JSON.stringify(validated, null, 2) + '\n');
      return this.read();
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
