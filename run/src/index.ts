import xs, {Stream, MemoryStream} from 'xstream';
import {adapt} from './adapt';

export interface FantasyObserver {
  next(x: any): void;
  error(err: any): void;
  complete(c?: any): void;
}

export interface FantasySubscription {
  unsubscribe(): void;
}

export interface FantasyObservable {
  subscribe(observer: FantasyObserver): FantasySubscription;
}

export type DisposeFunction = () => void;

export interface DevToolEnabledSource {
  _isCycleSource: string;
}

export interface Driver<Sink, Source> {
  (stream: Sink, driverName?: string): Source;
}

export type Drivers<So extends Sources, Si extends Sinks> = {
  [P in keyof (So & Si)]: Driver<Si[P], So[P]>;
};

export type Sources = {
  [name: string]: any;
};

export type Sinks = {
  [name: string]: FantasyObservable;
};

/**
 * Sink proxies should be MemoryStreams in order to fix race conditions for
 * drivers that subscribe to sink proxies "later".
 *
 * Recall that there are two steps:
 * 1. Setup (sink proxies -> drivers -> sources -> main -> sink)
 * 2. Execution (also known as replication: sink proxies imitate sinks)
 *
 * If a driver does not synchronously/immediately subscribe to the sink proxy
 * in step (1), but instead does that later, if step (2) feeds a value from the
 * sink to the sink proxy, then when the driver subscribes to the sink proxy,
 * it should receive that value. This is why we need MemoryStreams, not just
 * Streams. Note: Cycle DOM driver is an example of such case, since it waits
 * for 'readystatechange'.
 */
export type SinkProxies<Si extends Sinks> = {
  [P in keyof Si]: MemoryStream<any>;
};

export interface CycleProgram<So extends Sources, Si extends Sinks> {
  sources: So;
  sinks: Si;
  run(): DisposeFunction;
}

function logToConsoleError(err: any) {
  const target = err.stack || err;
  if (console && console.error) {
    console.error(target);
  } else if (console && console.log) {
    console.log(target);
  }
}

function makeSinkProxies<So extends Sources, Si extends Sinks>(
                        drivers: Drivers<So, Si>): SinkProxies<Si> {
  const sinkProxies: SinkProxies<Si> = {} as SinkProxies<Si>;
  for (const name in drivers) {
    if (drivers.hasOwnProperty(name)) {
      // create for drivers.
      sinkProxies[name] = xs.createWithMemory<any>();
    }
  }
  return sinkProxies;
}

function callDrivers<So extends Sources, Si extends Sinks>(
                    drivers: Drivers<So, Si>,
                    sinkProxies: SinkProxies<Si>): So {
  const sources: So = {} as So;
  for (const name in drivers) {
    if (drivers.hasOwnProperty(name)) {
      sources[name as any] = drivers[name](sinkProxies[name], name);
      if (sources[name as any] && typeof sources[name as any] === 'object') {
        (sources[name as any] as DevToolEnabledSource)._isCycleSource = name;
      }
    }
  }
  return sources;
}

// NOTE: this will mutate `sources`.
function adaptSources<So extends Sources>(sources: So): So {
  for (const name in sources) {
    if (sources.hasOwnProperty(name)
    && sources[name]
    && typeof sources[name]['shamefullySendNext'] === 'function') {
      sources[name] = adapt(sources[name] as any as Stream<any>);
    }
  }
  return sources;
}

/**
 * Notice that we do not replicate 'complete' from real sinks, in
 * SinksReplicators and ReplicationBuffers.
 * Complete is triggered only on disposeReplication. See discussion in #425
 * for details.
 */
type SinkReplicators<Si extends Sinks> = {
  [P in keyof Si]: {
    next(x: any): void;
    _n?(x: any): void;
    error(err: any): void;
    _e?(err: any): void;
    complete(): void;
  };
};

type ReplicationBuffers<Si extends Sinks> = {
  [P in keyof Si]: {
    _n: Array<any>;
    _e: Array<any>;
  };
};

function replicateMany<So extends Sources, Si extends Sinks>(
                      sinks: Si,
                      sinkProxies: SinkProxies<Si>): DisposeFunction {
  const sinkNames: Array<keyof Si> = Object.keys(sinks).filter(name => !!sinkProxies[name]);

  let buffers: ReplicationBuffers<Si> = {} as ReplicationBuffers<Si>;
  const replicators: SinkReplicators<Si> = {} as SinkReplicators<Si>;
  sinkNames.forEach((name) => {
    buffers[name] = {_n: [], _e: []};
    replicators[name] = {
      // push the value of sinks that came from main function to the buffers.
      // if the sinks is { DOM: $vdom }, $vdom is a dom stream returned from main function,
      // then the value will be the virtual dom from $vdom stream.
      next: (x: any) => buffers[name]._n.push(x),
      error: (err: any) => buffers[name]._e.push(err),
      complete: () => {},
    };
  });

  const subscriptions = sinkNames
    // this line will make stream of sinks that came from main function start.
    .map(name => xs.fromObservable(sinks[name] as any).subscribe(replicators[name]));

  sinkNames.forEach((name) => {
    // the listener is already connected to the drivers.
    const listener = sinkProxies[name];
    // listener is a instance of MemoryStream.
    // with a optional producer.
    // @see makeSinkProxies
    // @see callDrivers
    const next = (x: any) => { listener._n(x); };
    const error = (err: any) => { logToConsoleError(err); listener._e(err); };
    // `buffers` is a collection of values that emitted by sinks streams that
    // returned from main function.
    // `listener` will be the proxy of sinks to the drivers.
    buffers[name]._n.forEach(next);
    buffers[name]._e.forEach(error);
    replicators[name].next = next;
    replicators[name].error = error;
    // because sink.subscribe(replicator) had mutated replicator to add
    // _n, _e, _c, we must also update these:
    replicators[name]._n = next;
    replicators[name]._e = error;
  });
  buffers = null as any; // free up for GC

  return function disposeReplication() {
    subscriptions.forEach(s => s.unsubscribe());
    sinkNames.forEach((name) => sinkProxies[name]._c());
  };
}

function disposeSources<So extends Sources>(sources: So) {
  for (const k in sources) {
    if (sources.hasOwnProperty(k) && sources[k] && (sources[k] as any).dispose) {
      (sources[k] as any).dispose();
    }
  }
}

function isObjectEmpty(obj: any): boolean {
  return Object.keys(obj).length === 0;
}

/**
 * A function that prepares the Cycle application to be executed. Takes a `main`
 * function and prepares to circularly connects it to the given collection of
 * driver functions. As an output, `setup()` returns an object with three
 * properties: `sources`, `sinks` and `run`. Only when `run()` is called will
 * the application actually execute. Refer to the documentation of `run()` for
 * more details.
 *
 * **Example:**
 * ```js
 * import {setup} from '@cycle/run';
 * const {sources, sinks, run} = setup(main, drivers);
 * // ...
 * const dispose = run(); // Executes the application
 * // ...
 * dispose();
 * ```
 *
 * @param {Function} main a function that takes `sources` as input and outputs
 * `sinks`.
 * @param {Object} drivers an object where keys are driver names and values
 * are driver functions.
 * @return {Object} an object with three properties: `sources`, `sinks` and
 * `run`. `sources` is the collection of driver sources, `sinks` is the
 * collection of driver sinks, these can be used for debugging or testing. `run`
 * is the function that once called will execute the application.
 * @function setup
 */
export function setup<So extends Sources, Si extends Sinks>(
                     main: (sources: So) => Si,
                     drivers: Drivers<So, Si>): CycleProgram<So, Si> {
  if (typeof main !== `function`) {
    throw new Error(`First argument given to Cycle must be the 'main' ` +
      `function.`);
  }
  if (typeof drivers !== `object` || drivers === null) {
    throw new Error(`Second argument given to Cycle must be an object ` +
      `with driver functions as properties.`);
  }
  if (isObjectEmpty(drivers)) {
    throw new Error(`Second argument given to Cycle must be an object ` +
      `with at least one driver function declared as a property.`);
  }

  const sinkProxies = makeSinkProxies<So, Si>(drivers);
  // call the drivers use sink proxies.
  const sources = callDrivers<So, Si>(drivers, sinkProxies);
  const adaptedSources = adaptSources(sources);
  const sinks = main(adaptedSources);
  if (typeof window !== 'undefined') {
    (window as any).Cyclejs = (window as any).Cyclejs || {};
    (window as any).Cyclejs.sinks = sinks;
  }
  function run(): DisposeFunction {
    // connect sinks to sinkProxies.
    const disposeReplication = replicateMany(sinks, sinkProxies);
    return function dispose() {
      disposeSources(sources);
      disposeReplication();
    };
  };
  return {sinks, sources, run};
}

/**
 * Takes a `main` function and circularly connects it to the given collection
 * of driver functions.
 *
 * **Example:**
 * ```js
 * import run from '@cycle/run';
 * const dispose = run(main, drivers);
 * // ...
 * dispose();
 * ```
 *
 * The `main` function expects a collection of "source" streams (returned from
 * drivers) as input, and should return a collection of "sink" streams (to be
 * given to drivers). A "collection of streams" is a JavaScript object where
 * keys match the driver names registered by the `drivers` object, and values
 * are the streams. Refer to the documentation of each driver to see more
 * details on what types of sources it outputs and sinks it receives.
 *
 * @param {Function} main a function that takes `sources` as input and outputs
 * `sinks`.
 * @param {Object} drivers an object where keys are driver names and values
 * are driver functions.
 * @return {Function} a dispose function, used to terminate the execution of the
 * Cycle.js program, cleaning up resources used.
 * @function run
 */
export function run<So extends Sources, Si extends Sinks>(
                   main: (sources: So) => Si,
                   drivers: Drivers<So, Si>): DisposeFunction {
  const {run, sinks} = setup(main, drivers);
  if (typeof window !== 'undefined' && window['CyclejsDevTool_startGraphSerializer']) {
    window['CyclejsDevTool_startGraphSerializer'](sinks);
  }
  return run();
}

export default run;
