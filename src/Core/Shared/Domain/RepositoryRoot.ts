import { Context } from 'effect';

export class RepositoryRoot extends Context.Service<RepositoryRoot, string>()('RepositoryRoot') {}
