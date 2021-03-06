import { 
	Stats as FsStats, 
	WriteStream as FsWriteStream,
	exists as FsExists,
	stat as FsStat,
	readdir as FsReadDir,
	rename as FsRename,
	appendFile as FsAppendFile,
	WriteFileOptions as FsWriteFileOptions,
	createWriteStream as FsCreateWriteStream
} from "fs";
//import { serialize as V8Serialize } from "v8";
import { resolve as PathResolve } from "path";

import { ObjectHelper } from "./Helpers/ObjectHelper";
import { StringHelper } from "./Helpers/StringHelper";
import { MapHelper } from "./Helpers/MapHelper";
import { CallSite } from "./Loggers/CallSite";
import { StackTraceItem } from "./Loggers/StackTraceItem";


Error.prepareStackTrace = function(error: Error, stacks: CallSite[]) {
	Object.defineProperty(
		error, 'stacks', <PropertyDescriptor>{
			configurable: false,
			writable: false,
			enumerable: true,
			value: stacks
		}
	)
	return error.stack;
}

export class Logger {
	public static readonly LEVEL: {
		CRITICIAL: string,
		ERROR: string,
		WARNING: string,
		NOTICE: string,
		INFO: string,
		DEBUG: string
	} = {
		CRITICIAL: 'critical',
		ERROR: 'error',
		WARNING: 'warning',
		NOTICE: 'notice',
		INFO: 'info',
		DEBUG: 'debug'
	};
	protected static LOGS_EXT: string = '.log';
	protected static instance: Logger = null;
	protected documentRoot: string;
	protected logsDirFullPath: string;
	protected streamWriting: boolean = false;
	protected maxLogFileSize: number = 52428800; // 50 MB by default
	protected allowedLevels: Map<string, boolean> = new Map<string, boolean>();
	protected logsStreams: Map<string, FsWriteStream> = new Map<string, FsWriteStream>();
	protected logsStreamsLengths: Map<string, number> = new Map<string, number>();
	protected logsCaches: Map<string, string> = new Map<string, string>();
	protected writeStackTrace: boolean = true;
	protected writeStackTraceFuncArgs: boolean = false;
	protected maxDepth: number = 3;
	/**
	 * @summary Create new Logger instance.
	 * @param logsDirFullPath Directory full path with log files.
	 * @param documentRoot Application or project document root to simplify logged source file paths.
	 */
	public static CreateNew (logsDirFullPath: string, documentRoot: string): Logger {
		return new Logger(logsDirFullPath, documentRoot);
	}
	/**
	 * @summary Get logger instance as singleton.
	 */
	public static GetInstance (): Logger {
		return Logger.instance;
	}
	/**
	 * @summary Set logger instance as singleton.
	 * @param loggetInstance Logger instance.
	 */
	public static SetInstance (loggetInstance: Logger): Logger {
		return Logger.instance = loggetInstance;
	}
	/**
	 * @summary Create new Logger instance.
	 * @param logsDirFullPath Directory full path with log files.
	 * @param documentRoot Application or project document root to simplify logged source file paths.
	 */
	constructor (logsDirFullPath: string, documentRoot: string) {
		logsDirFullPath = PathResolve(logsDirFullPath).replace(/\\/g, '/');
		documentRoot = PathResolve(documentRoot).replace(/\\/g, '/');
		this.logsDirFullPath = StringHelper.TrimRight(logsDirFullPath, '/');
		this.documentRoot = StringHelper.TrimRight(documentRoot, '/');
		// allow all levels by default:
		for (var levelName in Logger.LEVEL) 
			this.allowedLevels.set(Logger.LEVEL[levelName], true);
		process.on('beforeExit', (code) => {
			this.logsStreams.forEach((stream: FsWriteStream, level: string) => {
				try {
					stream.end();
					stream.close();
				} catch (e) {}
			});
		});
	}
	/**
	 * @summary Set max. bytes for each log file. 50 MB by default.
	 * @see https://convertlive.com/u/convert/megabytes/to/bytes
	 * @param maxBytes Max bytes to create another log file (as number of bytes or as string like: 1K, 5M, 1G or 1T).
	 */
	public SetMaxLogFileSize (maxBytes: number | string = '50M'): Logger {
		if (!isNaN(maxBytes as any)) {
			this.maxLogFileSize = Number(maxBytes);
		} else {
			var maxBytesStr: string = String(maxBytes).toUpperCase();
			var numberStr: string = maxBytesStr.replace(/[^0-9\.]/g, '');
			var multiplier: string = maxBytesStr.replace(/[^KMGT]/g, '');
			if (numberStr.length == 0)
				throw new RangeError("Max. log file size is invalid.");
			var numberFloat: number = parseFloat(numberStr);
			if (multiplier.length > 0) {
				multiplier = multiplier.substr(0, 1);
				var multipliers: Map<string, number> = MapHelper.ObjectToMap({
					K: 1024,
					M: 1048576,
					G: 1073741824,
					T: 1099511627776
				});
				if (
					multipliers.has(multiplier) && 
					numberFloat * multipliers.get(multiplier) < Number.MAX_SAFE_INTEGER
				) 
					numberFloat *= multipliers.get(multiplier);
			}
			this.maxLogFileSize = numberFloat;
		}
		return this;
	}
	/**
	 * @summary Enable or disable writing to logs by write streams. If disabled, there is used standard file append. Disabled by default.
	 * @param allowedLevels `true` to enable stream writing (for singleton logger) or `false` for multiple logger instances to the same files. `false` by default.
	 */
	public SetStreamWriting (streamWriting: boolean = true): Logger {
		if (!streamWriting && this.streamWriting) 
			this.logsStreams.forEach((stream: FsWriteStream, level: string) => {
				try {
					stream.end();
					stream.close();
				} catch (e) {}
			});
		this.streamWriting = streamWriting;
		return this;
	}
	/**
	 * @summary Allowed levels to log. Rest of not presented levels are automatically disallowed.
	 * @param allowedLevels Allowed levels to log like: `[Logger.LEVEL.ERROR, Logger.LEVEL.DEBUG, 'customname', ...]`
	 */
	public SetAllowedLevels (allowedLevels: string[]): Logger {
		// set all existing levels to false first:
		this.allowedLevels.forEach((value: Boolean, allowedLevelName: string) => {
			this.allowedLevels.set(allowedLevelName, false);
		});
		// allow only selected levels:
		for (var levelName of allowedLevels) 
			this.allowedLevels.set(levelName, true);
		return this;
	}
	/**
	 * @summary Set how to write stack trace.
	 * @param writeStackTrace If `true`, stack trace will be written into all log types, `false` otherwise, default `true`.
	 * @param writeStackTraceFuncArgs If `true`, stack trace will be written with called functions arguments into all log types, `false` otherwise, default `true`. Arguments serialization could be very large.
	 */
	public SetStackTraceWriting(writeStackTrace: boolean = true, writeStackTraceFuncArgs = false): Logger {
		this.writeStackTrace = writeStackTrace;
		if (writeStackTrace) {
			this.writeStackTraceFuncArgs = writeStackTraceFuncArgs;
		} else {
			this.writeStackTraceFuncArgs = false;
		}
		return this;
	}
	/**
	 * @summary Set max depth to dump objects.
	 * @param maxDepth Default is `3`.
	 */
	public SetMaxDepth(maxDepth: number = 3): Logger {
		this.maxDepth = maxDepth;
		return this;
	}
	/**
	 * @summary Log any error.
	 * @param err Error instance to log or error message to generate an error internally and log the error instance.
	 * @param level Log level (log file name).
	 */
	public Error (err: Error | string, level: string = 'error'): Logger {
		var date: Date = new Date(),
			errMessage: string,
			errType: string,
			errStacks: CallSite[],
			stackTrace: StackTraceItem[];
		// check if current log level is allowed:
		if (
			!this.allowedLevels.has(level) || 
			!this.allowedLevels.get(level)
		) return this;
		// if input is string, turn it into error:
		if (err instanceof Error) {
			errType = ObjectHelper.RealTypeOf(err);
			errMessage = err.message;
			if (this.writeStackTrace && err.stack.length > 0)
				errStacks = err['stacks'] as CallSite[];
		} else {
			errType = 'Error';
			errMessage = err.toString();
			if (this.writeStackTrace) {
				try {
					throw new Error(err.toString());
				} catch (e1) {
					errStacks = e1['stacks'] as CallSite[];
				}
			}
		}
		// complete log record:
		var logRecordStr: string = '[' + date.toJSON() + '] [' + errType + ']: ' + errMessage + "\n";
		// serialize stack trace info if necessary:
		if (this.writeStackTrace) {
			stackTrace = this.getStackTraceItems(errStacks);
			logRecordStr += this.serializeStackTrace(stackTrace) + "\n\n";
		}
		// write log record:
		return this.appendToLogFile(logRecordStr, level);
	}
	/**
	 * @summary Log any stringified JS variable into log file with stack trace.
	 * @param obj any JS variable to log.
	 * @param level Log level (log file name).
	 */
	public Log (obj: any, level: string = 'debug'): Logger {
		var date: Date = new Date(),
			objSerialized: string,
			errStacks: CallSite[] = [],
			stackTrace: StackTraceItem[];
		// check if current log level is allowed:
		if (
			!this.allowedLevels.has(level) || 
			!this.allowedLevels.get(level)
		) return this;
		// serialize given object:
		objSerialized = this.serializeWhatIsPossible(obj, this.writeStackTrace, true);
		// complete log record:
		var logRecordStr: string = '[' + date.toJSON() + '] ' + objSerialized + "\n";
		// serialize stack trace info if necessary:
		if (this.writeStackTrace) {
			// complete stack trace by dummy error:
			try {
				throw new Error('Place error.');
			} catch (e3) {
				if (e3.stack.length > 0) {
					errStacks = e3['stacks'] as CallSite[];
					errStacks = errStacks.slice(1);
				}
			}
			stackTrace = this.getStackTraceItems(errStacks);
			logRecordStr += this.serializeStackTrace(stackTrace) + "\n\n";
		}
		// write log record:
		return this.appendToLogFile(logRecordStr, level);
	}
	protected appendToLogFile (msg: string, level: string): Logger {
		var logFullPath: string = this.logsDirFullPath + '/' + level + Logger.LOGS_EXT;
		if (this.streamWriting) {
			if (this.logsStreamsLengths.has(level) && this.logsStreamsLengths.get(level) > this.maxLogFileSize) {
				if (!this.logsStreams.has(level)) {
					// still renaming:
					this.logsCaches.set(level, this.logsCaches.get(level) + msg);
				} else {
					// begin rename:
					this.logsCaches.set(level, msg);
					var stream: FsWriteStream = this.logsStreams.get(level);
					stream.end();
					stream.close();
					this.logsStreams.delete(level);
					this.renameFullLogFile(level, () => {
						this.logsStreamsLengths.set(level, 0);
						var msgLocal: string = this.logsCaches.get(level);
						this.logsCaches.set(level, '');
						this.appendToLogFileByStream(msgLocal, level, logFullPath);
					});
				}
			} else {
				this.appendToLogFileByStream(msg, level, logFullPath);
			}
		} else {
			FsExists(logFullPath, (exists: boolean) => {
				if (!exists) {
					this.appendToLogFileByStandardWrite(msg, level, logFullPath);
				} else {
					FsStat(logFullPath, (errLocal: Error, stats: FsStats) => {
						if (errLocal) {
							this.logsCaches.set(level, this.logsCaches.get(level) + msg);
							return console.error(errLocal);
						}
						if (stats.size > this.maxLogFileSize) {
							this.renameFullLogFile(level, () => {
								this.logsStreamsLengths.set(level, 0);
								var msgLocal: string = this.logsCaches.get(level);
								this.logsCaches.set(level, '');
								this.appendToLogFileByStandardWrite(msgLocal, level, logFullPath);
							});
						} else {
							this.appendToLogFileByStandardWrite(msg, level, logFullPath);
						}
					});
				}
			});
		}
		return this;
	}
	protected renameFullLogFile (level: string, cb: () => void) {
		var oldFullPath: string = this.logsDirFullPath + '/' + level + Logger.LOGS_EXT;
		FsStat(oldFullPath, (errLocal1: Error, stats: FsStats) => {
			if (errLocal1) 
				return console.error(errLocal1);
			var date: Date = stats.ctime,
				newFileNameLevels: string[] = [
					// _2020-01-01:
					'_' + ([
						date.getFullYear().toString(),
						((date.getMonth() + 1) / 100).toFixed(2).substr(2),
						(date.getDate() / 100).toFixed(2).substr(2)
					].join('-')),
					// _01-01
					'_' + ([
						(date.getHours() / 100).toFixed(2).substr(2),
						(date.getMinutes() / 100).toFixed(2).substr(2),
						(date.getSeconds() / 100).toFixed(2).substr(2)
					].join('-')),
					// _123
					[
						'_',
						(date.getMilliseconds() / 1000).toFixed(3).substr(2)
					].join('')
				];
			FsReadDir(this.logsDirFullPath, (errLocal2: Error, files: string[]) => {
				if (errLocal2) 
					return console.error(errLocal2);
				var newFileName: string = level;
				for (var i: number = 0, l = newFileNameLevels.length; i < l; i++) {
					newFileName += newFileNameLevels[i];
					if (files.indexOf(newFileName + Logger.LOGS_EXT) === -1) 
						break;
				}
				FsRename(
					this.logsDirFullPath + '/' + level + Logger.LOGS_EXT,
					this.logsDirFullPath + '/' + newFileName + Logger.LOGS_EXT,
					(errLocal3: Error) => {
						if (errLocal3) 
							return console.error(errLocal3);
						cb();
					}
				)
			});
		});
	}
	protected appendToLogFileByStandardWrite (msg: string, level: string, logFullPath: string): void {
		FsAppendFile(logFullPath, msg, <FsWriteFileOptions>{
			encoding: 'utf8',
			mode: 0o666,
			flags: 'a+'
		}, (errLocal: Error) => {
			if (errLocal) console.error(errLocal);
		});
	}
	protected appendToLogFileByStream (msg: string, level: string, logFullPath: string): void {
		var stream: FsWriteStream;
		if (this.logsStreams.has(level)) {
			stream = this.logsStreams.get(level);
		} else {
			stream = FsCreateWriteStream(
				logFullPath, {
					flags: 'a+', // write appending, created if doesn't exist
					autoClose: false,
					encoding: 'utf8',
					mode: 0o666
				}
			);
			this.logsStreams.set(level, stream);
			this.logsStreamsLengths.set(level, 0);
		}
		stream.write(
			msg, (errLocal: Error) => {
				if (errLocal) {
					stream.end();
					stream.close();
					this.logsStreams.delete(level);
					console.error(errLocal);
				} else {
					this.logsStreamsLengths.set(
						level,
						this.logsStreamsLengths.get(level) + Buffer.byteLength(msg, 'utf8')
					);
				}
			}
		);
	}
	protected serializeStackTrace (items: StackTraceItem[]): string {
		var result: string[] = [],
			item: StackTraceItem,
			fileLine: string;
		for (var i: number = 0, l: number = items.length; i < l; i++) {
			item = items[i];
			fileLine = '';
			if (!item.isNative && item.file && item.line && item.column) 
				fileLine = String(item.file) + ':' + String(item.line) + ':' + String(item.column);
			result.push(
				"\t-> " + item.fnFullName + '(' + item.argumentsSerialized + ');'
				+ (fileLine.length > 0 ? "\n\t   " + fileLine : "")
			);
		}
		return result.join("\n");
	}
	protected getStackTraceItems (stacks: CallSite[]): StackTraceItem[] {
		var stackTraceItems: StackTraceItem[] = [];
		for (var i: number = 0, l: number = stacks.length; i < l; i++) 
			stackTraceItems.push(
				this.getStackTraceItem(stacks[i])
			);
		return stackTraceItems;
	}
	protected getStackTraceItem (stack: CallSite): StackTraceItem {
		var isTopLevel: boolean,
			isConstructor: boolean,
			fnFullName: string | null,
			evalOrigin: string | null,
			fn: Function,
			args: any[] = [],
			argsStr: string = '',
			file: string;
		// arguments:
		if (this.writeStackTraceFuncArgs) {
			fn = stack.getFunction();
			if (fn) {
				args = [];
				try {
					args = fn.arguments ? [].slice.apply(fn.arguments) : [];
				} catch (e1) {}
				if (args.length > 0) {
					argsStr = this.getStackTraceItemSerializedArgs(args);
				}
			}
		}
		// file:
		file = Boolean(stack.getScriptNameOrSourceURL)
			? stack.getScriptNameOrSourceURL()
			: stack.getFileName();
		if (file) {
			file = file.replace(/\\/g, '/');
			if (file.indexOf(this.documentRoot) === 0) 
				file = '.' + file.substr(this.documentRoot.length);
		}
		// eval origin file:
		evalOrigin = stack.getEvalOrigin();
		if (evalOrigin)
			evalOrigin = evalOrigin.replace(/\\/g, '/');
		// function full name:
		isTopLevel = stack.isToplevel();
		isConstructor = stack.isConstructor();
		fnFullName = this.getStackTraceItemFuncFullName(
			stack, isTopLevel, isConstructor
		);
		// return result:
		return <StackTraceItem>{
			stack: stack,
			scope: stack.getThis(),
			fnFullName: fnFullName,
			isConstructor: isConstructor,
			isNative: stack.isNative(),
			isToplevel: isTopLevel,
			isEval: stack.isEval(),
			arguments: args,
			argumentsSerialized: argsStr,
			file: file,
			line: stack.getLineNumber(),
			column: stack.getColumnNumber(),
			evalOrigin: evalOrigin
		};
	}
	protected getStackTraceItemSerializedArgs (args: any[]): string {
		var arg: any,
			result: string[] = [],
			separator: string = '';
		for (var j: number = 0, k: number = args.length; j < k; j++) {
			arg = args[j];
			result.push(separator);
			result.push(this.serializeWhatIsPossible(arg, false, false));
			separator = ',';
		}
		return result.join('');
	}
	protected serializeWhatIsPossible (obj: any, prettyPrint: boolean = false, addTypeName: boolean = true): string {
		var result: string;
		try {
			result = this.stringifyRecursive(prettyPrint, addTypeName, 0, '', obj);
		} catch (e) {
			result = e.message;
		}
		return result;
	}
	protected stringifyRecursive (prettyPrint: boolean, addTypeName: boolean, level: number, indent: string, obj: any): any {
		var result: string[] = [],
			baseSeparator: string = '',
			separator: string = '',
			rawValue: any,
			key: string,
			item: string,
			itemsIndent: string,
			newLine: string = "\n",
			doubleDot: string = ': ',
			isArray: boolean = false,
			isMap: boolean = false,
			isSet: boolean = false;
		if (ObjectHelper.IsPrimitiveType(obj)) {
			if (obj === undefined) return 'undefined';
			if (obj === null) return 'null';
			if (obj.constructor === Number) {
				if (Number.isNaN(obj)) return 'NaN';
				if (!Number.isFinite(obj)) {
					if (obj < 0) return '-Infinity';
					return 'Infinity';
				}
				return JSON.stringify(obj);
			} else {
				return JSON.stringify(obj);
			}
		} else if (obj instanceof Function) {
			return '[' + obj.name + ' Function(' + obj.length + ')]';
		}
		if (level == this.maxDepth)
			return '[' + ObjectHelper.RealTypeOf(obj) + ']';
		var objProto: any = Object.getPrototypeOf(obj);
		if (prettyPrint) {
			itemsIndent = indent + "\t";
			baseSeparator = ",\n";
		} else {
			newLine = '';
			indent = '';
			doubleDot = ':';
			itemsIndent = '';
			baseSeparator = ',';
		}
		if (
			//Helpers.RealTypeOf(obj) == 'Array' | 'Uint8Array' | ... &&
			'length' in objProto
		) {
			isArray = true;
			if (obj.length == 0) {
				result.push('[]');
			} else {
				result.push('[' + newLine);
				for (var i: number = 0, l = obj.length; i < l; i++) {
					try {
						item = this.stringifyRecursive(prettyPrint, addTypeName, level + 1, itemsIndent, obj[i]);
					} catch (e1) {
						item = '[' + ObjectHelper.RealTypeOf(obj[i]) + ']';
					}
					result.push(separator + itemsIndent + item);
					separator = baseSeparator;
				}
				result.push(newLine + indent + ']');
			}
		} else if (obj instanceof global.RegExp) {
			var regExp: RegExp = obj as any;
			result.push('/' + regExp.source + '/' + regExp.flags);
		} else if (obj instanceof global.Map) {
			isMap = true;
			var objMap: Map<any, any> = obj as any;
			if (objMap.size == 0) {
				result.push('{}');
			} else {
				result.push('{' + newLine);
				for (var [rawKey, rawValue] of objMap) {
					try {
						key = JSON.stringify(rawKey);
						item = this.stringifyRecursive(prettyPrint, addTypeName, level + 1, itemsIndent, rawValue);
					} catch (e1) {
						key = String(rawKey);
						item = '[' + ObjectHelper.RealTypeOf(rawValue) + ']';
					}
					result.push(separator + itemsIndent + key + doubleDot + item);
					separator = baseSeparator;
				}
				result.push(newLine + indent + '}');
			}
		} else if (obj instanceof global.Set) {
			isSet = true;
			var objSet: Set<any> = obj as any;
			if (objSet.size == 0) {
				result.push('[]');
			} else {
				result.push('[' + newLine);
				for (var rawValue of objSet) {
					try {
						item = this.stringifyRecursive(prettyPrint, addTypeName, level + 1, itemsIndent, rawValue);
					} catch (e1) {
						item = '[' + ObjectHelper.RealTypeOf(rawValue) + ']';
					}
					result.push(separator + itemsIndent + item);
					separator = baseSeparator;
				}
				result.push(newLine + indent + ']');
			}
		} else if (obj.exports && obj.exports.__esModule && obj.constructor && obj.constructor.name == 'Module') {
			var file: string = String(obj.filename).replace(/\\/g, '/');
			if (file.indexOf(this.documentRoot) === 0) 
				file = '.' + file.substr(this.documentRoot.length);
			return '[' + file + ' Module]';
		} else {
			var objKeys: string[] = Object.keys(obj);
			if (objKeys.length == 0) {
				result.push('{}');
			} else {
				result.push('{' + newLine);
				for (var rawKey2 of objKeys) {
					rawValue = obj[rawKey2];
					try {
						key = JSON.stringify(rawKey2);
						item = this.stringifyRecursive(prettyPrint, addTypeName, level + 1, itemsIndent, rawValue);
					} catch (e1) {
						key = String(rawKey2);
						item = '[' + ObjectHelper.RealTypeOf(rawValue) + ']';
					}
					result.push(separator + itemsIndent + key + doubleDot + item);
					separator = baseSeparator;
				}
				result.push(newLine + indent + '}');
			}
		}
		if (addTypeName) {
			result.push(' [' + ObjectHelper.RealTypeOf(obj));
			if (isArray) {
				result.push('(' + String(obj.length) + ')');
			} else if (isMap || isSet) {
				result.push('(' + String(obj.size) + ')');
			}
			result.push(']');
		}
		return result.join('');
	}
	protected getStackTraceItemFuncFullName (stack: CallSite, isTopLevel: boolean, isConstructor: boolean): string {
		var fnFullName: string,
			methodName: string | null,
			typeName: string | null,
			funcName: string | null;
		if (isTopLevel) {
			fnFullName = stack.getFunctionName();
		} else if (isConstructor) {
			fnFullName = stack.getTypeName() + '.constructor';
		} else {
			methodName = stack.getMethodName();
			typeName = stack.getTypeName();
			funcName = stack.getFunctionName();
			if (methodName == null && typeName !== null) {
				if (!funcName) funcName = '<anonymous>';
				fnFullName = typeName + '.' + stack.getFunctionName();
			} else if (methodName !== null && typeName !== null) {
				fnFullName = typeName + '.' + methodName;
			} else {
				fnFullName = stack.getFunctionName();
			}
		}
		return fnFullName;
	}
};