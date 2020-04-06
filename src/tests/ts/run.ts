import { Server, Request, Response, Event, Tools } from "../../lib/Server";

var rootDir = __dirname + '/../../..';

var logger = Tools.Logger.CreateNew(rootDir, rootDir)
				.SetStackTraceWriting(true, true);

Server.CreateNew()
	.SetDocumentRoot(rootDir)
	.SetPort(8000)
	.SetHostname('web-dev-server.local')	// optional, localhost by default
	.SetDevelopment(true)
	//.SetBasePath('/node')
	.SetErrorHandler(async (
		err: Error,
		code: number,
		req: Request,
		res: Response
	) => {
		console.error(err);
		logger.Error(err);
	})
	.AddPreHandler(async (
		req: Request,
		res: Response,
		event: Event
	) => {
		if (req.GetPath() == '/health') {
			res.SetCode(200).SetBody('1').Send();
			event.PreventDefault();
		}
		/*setTimeout(function () {
			throw new Error("Test error:-)");
		}, 1000);*/
	})
	.Start();
