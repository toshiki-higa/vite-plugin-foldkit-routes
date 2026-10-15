import { Effect, Option, Schema } from 'effect';
import { Command, Navigation, Runtime, Subscription, Update, Url } from 'foldkit';
import { defineMessageUnion } from 'foldkit/message';
import * as App from './app.gen.ts';

const Model = Schema.Struct({ pages: App.Model });
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  Route: { message: App.Message },
  ClickedLink: { request: Navigation.UrlRequest },
  Navigated: {},
});
type Message = typeof Message.Type;
type Return = Update.Return<Model, Message, App.Requirements>;

const routeMessage = (message: App.Message): Message => Message.Route({ message });
const updatePages = Update.foldChild({
  update: App.update,
  read: (model: Model) => Option.some(model.pages),
  write: (model: Model, pages: App.Model): Model => ({ ...model, pages }),
  toParentMessage: routeMessage,
});
const Navigate = Command.define('Navigate', {
  args: { request: Navigation.UrlRequest },
  messages: [Message.Navigated],
  execute: ({ request }) =>
    Navigation.UrlRequest.match(request, {
      Internal: ({ url }) => Navigation.pushUrl(Url.toString(url)),
      External: ({ href }) => Navigation.load(href),
    }).pipe(Effect.as(Message.Navigated())),
});

Runtime.run(
  Runtime.makeApplication({
    Model,
    init: (url): Return =>
      Update.foldChildInit(App.init(url), {
        toParentModel: (pages) => Model.make({ pages }),
        toParentMessage: routeMessage,
      }),
    update: (model, message): Return =>
      Message.match(message, {
        Route: ({ message: child }) => updatePages(model, child),
        ClickedLink: ({ request }) => ({ model, commands: [Navigate({ request })] }),
        Navigated: () => ({ model }),
      }),
    view: (model, h) => ({
      title: 'Foldkit file routes',
      body: h.main(
        [],
        [
          h.nav(
            [h.AriaLabel('Main navigation')],
            [
              h.a([h.Href(App.href({ to: '/' }))], ['Home']),
              h.a([h.Href(App.href({ to: '/about' }))], ['About']),
            ],
          ),
          h.submodel({
            slotId: 'pages',
            view: App.view,
            model: model.pages,
            toParentMessage: routeMessage,
          }),
        ],
      ),
    }),
    subscriptions: Subscription.lift(App.subscriptions)<Model, Message>({
      read: (model) => Option.some(model.pages),
      toParentMessage: routeMessage,
    }),
    container: document.getElementById('app'),
    routing: {
      onUrlRequest: (request) => Message.ClickedLink({ request }),
      onUrlChange: (url) => routeMessage(App.Message.ChangedUrl({ url })),
    },
    devTools: false,
  }),
);
