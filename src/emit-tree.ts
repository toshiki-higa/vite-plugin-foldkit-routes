import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Manifest, Page, Layout } from './discover.ts';
import type { GeneratedFile } from './files.ts';
import {
  inheritedParamsConfig,
  ownerIdentifier,
  pageIdentifiers,
  paramFields,
} from './emission.ts';

const q = JSON.stringify;
const has = (node: Page | Layout, name: string) => node.exports.includes(name);
const relative = (file: string) => './' + path.posix.relative('src', file);
type Owner = { node: Page | Layout; name: string; layout: boolean; index: number };

/** Unroll the finite discovered tree. Local models are always opaque schemas. */
export function treeComposition(manifest: Manifest, flat: GeneratedFile): GeneratedFile {
  const owners: Owner[] = [
    ...manifest.layouts.map((node, index) => ({
      node,
      name: ownerIdentifier(true, index),
      layout: true,
      index,
    })),
    ...manifest.pages.map((node, index) => ({
      node,
      name: ownerIdentifier(false, index),
      layout: false,
      index,
    })),
  ];
  const layouts = owners.filter((o) => o.layout);
  const pages = owners.filter((o) => !o.layout);
  const lookup = (id: string) => layouts.find((o) => o.node.id === id)!;
  const field = (o: Owner) => q(o.node.id);
  const state = (o: Owner, m = 'model') => (o.layout ? `${m}.layouts[${field(o)}]` : `${m}.page`);
  const tag = (o: Owner) => q(o.layout ? o.node.id : o.node.pattern);
  const type = (o: Owner) => `${o.name}State`;
  const input = (o: Owner) => `${o.name}Input`;
  const active = (o: Owner, m = 'model') =>
    o.layout ? `${state(o, m)}!==null` : `${m}.page._tag===${tag(o)}`;
  const wrap = (o: Owner, occ = 'occurrence') =>
    `(message:typeof ${o.name}.Message.Type):Message=>Message[${tag(o)}]({occurrence:${occ},message})`;
  const provider = (o: Owner) =>
    o.node.layouts.map(lookup).findLast((a) => has(a.node, 'ChildContext'));
  const contextSchema = (o: Owner) =>
    provider(o) ? `${provider(o)!.name}.ChildContext` : 'Schema.Struct({})';
  const paramNames = (o: Owner) =>
    o.node.segments.filter((s) => s.kind !== 'static').map((s) => s.name);
  const config = (o: Owner) =>
    inheritedParamsConfig(
      [...o.node.layouts.map(lookup), o]
        .filter((a) => has(a.node, 'route'))
        .map((a) => `${a.name}.route`),
    );
  const outConfig = (o: Owner) =>
    !has(o.node, 'OutMessage')
      ? ''
      : o.node.receiver
        ? `foldOutMessage:(message:typeof ${o.name}.OutMessage.Type)=>(model:Model):InternalReturn=>receive${lookup(o.node.receiver).name}(model,message),`
        : `toParentOutMessage:(message:typeof ${o.name}.OutMessage.Type)=>OutMessage[${tag(o)}]({message}),`;
  const lens = (
    o: Owner,
    semantic = true,
  ) => `read:(model:Model)=>${active(o)} && ${state(o)}!.occurrence===occurrence ? Option.some(${state(o)}!.model) : Option.none(),
write:(model:Model,child:typeof ${o.name}.Model.Type):Model=>${active(o)} ? ${o.layout ? `({...model,layouts:{...model.layouts,[${field(o)}]:{...${state(o)}!,model:child}}})` : `({...model,page:{...model.page,model:child}})`}:model,
toParentMessage:${wrap(o)},${semantic ? outConfig(o) : ''}`;
  const writeState = (o: Owner, value: string) =>
    o.layout
      ? `({...model,layouts:{...model.layouts,[${field(o)}]:${value}}})`
      : `({...model,page:${value}})`;
  const definition = createHash('sha256')
    .update(JSON.stringify(manifest.pages.map((p) => [p.pattern, p.fingerprint])))
    .digest('hex');
  const external = owners.filter((o) => has(o.node, 'OutMessage') && !o.node.receiver);
  const requirements =
    owners
      .flatMap((o) =>
        ['init', 'update', 'inform', 'onChildOutMessage', 'restore']
          .filter((n) => has(o.node, n))
          .map((n) => `RequirementsOf<ReturnType<typeof ${o.name}.${n}>>`),
      )
      .join('|') || 'never';
  // URL declarations retain the native ordered parser and acceptance filters.
  // pageIdentifiers names their schemas/equivalences consumed below; the prelude
  // is opaque emitted text, never parsed or interpreted by tree composition.
  const prelude = flat.content;
  function emitDeclarations(o: Owner): string {
    const params = o.layout
      ? `Schema.Struct({${paramFields(o.node.segments, config(o))}})`
      : pageIdentifiers(o.index).params;
    return `const ${o.name}InputSchema=Schema.Struct({params:${params},search:${o.layout ? 'Schema.Struct({})' : pageIdentifiers(o.index).search},context:${contextSchema(o)}});
const equal${o.name}Input=Schema.toEquivalence(${o.name}InputSchema);
const equal${o.name}Context=Schema.toEquivalence(${contextSchema(o)});
const ${type(o)}=Schema.Struct({occurrence:Schema.Int,definition:Schema.Literal(${q(o.node.fingerprint)}),scope:Schema.String,input:${o.name}InputSchema${has(o.node, 'Model') ? `,model:${o.name}.Model` : ''}});
${!o.layout ? `const input${o.index}=(route:typeof AppRoute[${tag(o)}]['Type'],context:${input(o)}['context']):${input(o)}=>({params:route.params,search:route.search,context});` : ''}`;
  }
  function emitActivation(o: Owner): string {
    const chain = o.node.layouts.map(lookup);
    const descendants = o.layout ? pages.filter((p) => p.node.layouts.includes(o.node.id)) : [];
    const routeCases = descendants
      .map(
        (p) =>
          `case ${tag(p)}: params={${paramNames(o)
            .map((n) => `[${q(n)}]:route.params[${q(n)}]`)
            .join(',')}};break;`,
      )
      .join('\n');
    const root = o.layout && path.posix.dirname(o.node.relativeFile) === 'src/routes';
    // An owner with no pages is inert. Avoid emitting unreachable
    // ancestry reads after an exhaustive default-return switch: TypeScript
    // cannot soundly narrow nullable states in that unreachable remainder.
    if (o.layout && !root && descendants.length === 0)
      return `const activate${o.name}=(_model:Model):Option.Option<{scope:string;input:${input(o)}}>=>Option.none();`;
    return `const activate${o.name}=(model:Model):Option.Option<{scope:string;input:${input(o)}}>=>{
 const route=model.route;
 ${o.layout ? `let params:${input(o)}['params'];switch(route._tag){${routeCases}\n${root ? "case 'NotFound':params={};break;" : ''}default:return Option.none();}` : `if(route._tag!==${tag(o)})return Option.none();`}
 const scope:Array<string|number>=[];
 ${chain
   .map(
     (a) => `const state${a.name}=${state(a)};
 if(state${a.name}===null)return Option.none();
 scope.push(state${a.name}.occurrence);
 ${
   has(a.node, 'provide')
     ? `const provided${a.name}=provide${a.name}(state${a.name}.model,state${a.name}.input);
 if(Option.isNone(provided${a.name}))return Option.none();
 if(typeof provided${a.name}.value.key==='number'&&!Number.isFinite(provided${a.name}.value.key))throw new Error('Layout provide key must be a string or finite number');
 scope.push(provided${a.name}.value.key);`
     : ''
 }`,
   )
   .join('\n')}
 return Option.some({scope:JSON.stringify(scope),input:${o.layout ? `{params,search:{},context:${provider(o) ? `provided${provider(o)!.name}.value.context` : '{}'}}` : `input${o.index}(route,${provider(o) ? `provided${provider(o)!.name}.value.context` : '{}'})`}});
};`;
  }
  function emitOwnerFunctions(o: Owner): string {
    const stateful = has(o.node, 'Model');
    const ownerRequirements =
      ['init', 'update', 'inform', 'onChildOutMessage', 'restore']
        .filter((name) => has(o.node, name))
        .map((name) => `RequirementsOf<ReturnType<typeof ${o.name}.${name}>>`)
        .join('|') || 'never';
    // Normalize inferred heterogeneous branches BEFORE native fold inference.
    // The annotation widens only to the exact discovered service union, never
    // to unknown/any/never, and assignment checks every authored branch.
    const folded = stateful
      ? `type ${o.name}Requirements=${ownerRequirements};
type ${o.name}Return=Update.ReturnWithOutMessage<typeof ${o.name}.Model.Type,typeof ${o.name}.Message.Type,${has(o.node, 'OutMessage') ? `typeof ${o.name}.OutMessage.Type` : 'never'},${o.name}Requirements>;
const init${o.name}:(input:${input(o)})=>${o.name}Return=${o.name}.init;
const update${o.name}:(model:typeof ${o.name}.Model.Type,message:typeof ${o.name}.Message.Type,input:${input(o)})=>${o.name}Return=${o.name}.update;
${has(o.node, 'inform') ? `const informUpdate${o.name}:(model:typeof ${o.name}.Model.Type,change:${o.name}InputChange)=>${o.name}Return=${o.name}.inform;` : ''}
${has(o.node, 'provide') ? `const provide${o.name}:(model:typeof ${o.name}.Model.Type,input:${input(o)})=>ReturnType<typeof ${o.name}.provide>=${o.name}.provide;` : ''}
${has(o.node, 'ChildOutMessage') ? `const receiver${o.name}:(model:typeof ${o.name}.Model.Type,message:typeof ${o.name}.ChildOutMessage.Type,input:${input(o)})=>${o.name}Return=${o.name}.onChildOutMessage;` : ''}
const fold${o.name}=(occurrence:number,current:${input(o)})=>Update.foldChild({update:(local:typeof ${o.name}.Model.Type,message:typeof ${o.name}.Message.Type)=>update${o.name}(local,message,current),${lens(o)}});
${has(o.node, 'inform') ? `const inform${o.name}=(occurrence:number)=>Update.foldChild({update:informUpdate${o.name},${lens(o)}});` : ''}`
      : '';
    const receiver = has(o.node, 'ChildOutMessage')
      ? `const receive${o.name}=(model:Model,message:typeof ${o.name}.ChildOutMessage.Type):InternalReturn=>{
const current=${state(o)};const activation=activate${o.name}(model);
if(current===null||Option.isNone(activation)||current.scope!==activation.value.scope)return {model};
const occurrence=current.occurrence;
return Update.foldChild({update:(local:typeof ${o.name}.Model.Type,request:typeof ${o.name}.ChildOutMessage.Type)=>receiver${o.name}(local,request,activation.value.input),${lens(o)}})(model,message);
};`
      : '';
    const built = o.layout
      ? `${type(o)}.make({occurrence,definition:${q(o.node.fingerprint)},scope:activation.value.scope,input:activation.value.input${stateful ? ',model:child' : ''}})`
      : `PageState[${tag(o)}]({route:model.route as typeof AppRoute[${tag(o)}]['Type'],occurrence,definition:${q(o.node.fingerprint)},scope:activation.value.scope,input:activation.value.input${stateful ? ',model:child' : ''}})`;
    return `${folded}\n${receiver}
const reconcile${o.name}=(model:Model):InternalReturn=>{
 const activation=activate${o.name}(model);
 if(Option.isNone(activation))return {model:${o.layout ? `${state(o)}===null?model:${writeState(o, 'null')}` : `{...model,page:PageState.Gated({route:model.route,occurrence:0,definition:${q(definition)}})}`}};
 const current=${state(o)};
 if(${o.layout ? 'current!==null' : `current._tag===${tag(o)}`} && 'input' in current && current.scope===activation.value.scope && ${o.layout ? `Schema.toEquivalence(${o.name}InputSchema.fields.params)(current.input.params,activation.value.input.params)` : `${pageIdentifiers(o.index).equalParams}(current.route.params,activation.value.input.params)`}){
  if(equal${o.name}Input(current.input,activation.value.input))return {model:${o.layout ? 'model' : `{...model,page:{...current,route:model.route as typeof AppRoute[${tag(o)}]['Type']}}`}};
  const previous=current.input;const next=activation.value.input;
  const withInput:Model=${writeState(o, `{...current,input:next${o.layout ? '' : `,route:model.route as typeof AppRoute[${tag(o)}]['Type']`}}`)};
  ${stateful && has(o.node, 'inform') ? `return inform${o.name}(current.occurrence)(withInput,{previous,current:next,changed:{params:false,search:${o.layout ? 'false' : `!${pageIdentifiers(o.index).equalSearch}(previous.search,next.search)`},context:!equal${o.name}Context(previous.context,next.context)}});` : 'return {model:withInput};'}
 }
 const occurrence=model.serial+1;
 ${
   stateful
     ? `return Update.foldChildInit(init${o.name}(activation.value.input),{
 toParentModel:(child:typeof ${o.name}.Model.Type):Model=>({...${writeState(o, built)},serial:occurrence}),toParentMessage:${wrap(o)},${outConfig(o)}});`
     : `return {model:{...${writeState(o, built)},serial:occurrence}};`
 }
};
const View${o.name}=Submodel.defineView<${stateful ? `typeof ${o.name}.Model.Type,typeof ${o.name}.Message.Type` : 'null,never'},${o.name}ViewInputs>(${stateful ? `${o.name}.view` : `(_model,input,h)=>${o.name}.view(input,h)`});`;
  }
  function emitRestoreOwner(o: Owner): string {
    const current = state(o);
    const present = o.layout ? 'current!==null' : `current._tag===${tag(o)}`;
    const params = o.layout
      ? `Schema.toEquivalence(${o.name}InputSchema.fields.params)(current.input.params,activation.value.input.params)`
      : `${pageIdentifiers(o.index).equalParams}(current.route.params,activation.value.input.params)`;
    const callback = has(o.node, 'Model') && has(o.node, 'restore');
    const withInput = writeState(o, '{...current,input:activation.value.input}');
    return `const validRestore${o.name}=(model:Model,checkContext:boolean):boolean=>{
 const current=${current};const activation=activate${o.name}(model);
 if(Option.isNone(activation))return ${o.layout ? 'current===null' : `current._tag!==${tag(o)}`};
 return ${present}&&current.scope===activation.value.scope&&${params}&&(!checkContext||equal${o.name}Input(current.input,activation.value.input));
};
${
  has(o.node, 'provide')
    ? `const sameProvider${o.name}=(before:Model,after:Model):boolean=>{
 const left=${state(o, 'before')};const right=${state(o, 'after')};
 if(left===null||right===null)return left===right;
 const a=provide${o.name}(left.model,left.input);const b=provide${o.name}(right.model,right.input);
 return Option.isNone(a)?Option.isNone(b):Option.isSome(b)&&a.value.key===b.value.key;
};`
    : ''
}
${callback ? `const restoreUpdate${o.name}:(model:typeof ${o.name}.Model.Type,input:${input(o)})=>Update.Return<typeof ${o.name}.Model.Type,typeof ${o.name}.Message.Type,${o.name}Requirements>=${o.name}.restore;` : ''}
const restoreOwner${o.name}=(model:Model):Update.Return<Model,Message,AllRequirements>=>{
 const current=${current};const activation=activate${o.name}(model);
 if(${o.layout ? 'current===null' : `current._tag!==${tag(o)}`}||Option.isNone(activation))return {model};
 const withInput:Model=${withInput};
 ${
   callback
     ? `const occurrence=current.occurrence;
 return Update.foldChild({update:restoreUpdate${o.name},${lens(o, false)}})(withInput,activation.value.input);`
     : 'return {model:withInput};'
 }
};`;
  }
  const restoreChecks =
    owners.map((o) => `validRestore${o.name}(model,checkContext)`).join('&&') || 'true';
  const providerChecks =
    owners
      .filter((o) => has(o.node, 'provide'))
      .map((o) => `sameProvider${o.name}(before,after)`)
      .join('&&') || 'true';
  const restoreAbsent = owners
    .filter((o) => has(o.node, 'Model') && !has(o.node, 'restore'))
    .map(
      (o) =>
        `if(${active(o)})return {_tag:'Reset',reason:'MissingOwnerRestore',source:${q(o.node.relativeFile)}};`,
    )
    .join('\n');
  const subscriptions = owners.flatMap((o) =>
    (o.node.subscriptionKeys ?? []).map(
      (key) =>
        `liftOccurrence({owner:${o.name}.subscriptions[${q(key)}],key:${q(o.node.id + '/' + key)},read:(model:Model)=>{const current=${state(o)};if(${o.layout ? 'current===null' : `current._tag!==${tag(o)}`})return Option.none();const activation=activate${o.name}(model);return Option.isSome(activation)&&activation.value.scope===current.scope?Option.some({occurrence:current.occurrence,model:${has(o.node, 'Model') ? 'current.model' : 'null'}}):Option.none();},toParentMessage:${has(o.node, 'Model') ? `(message:typeof ${o.name}.Message.Type,occurrence:number):Message=>Message[${tag(o)}]({occurrence,message})` : '(message:never)=>message'}})`,
    ),
  );
  const emitRender = (
    o: Owner,
  ) => `const render${o.name}=(model:Model,h:HtmlBuilder<Message>,outlet:()=>Html):Html=>{
 const current=${state(o)};if(${o.layout ? 'current===null' : `current._tag!==${tag(o)}`})return null;
 const activation=activate${o.name}(model);if(Option.isNone(activation)||current.scope!==activation.value.scope)return null;
 return h.keyed('div')(current.occurrence,[],[h.submodel({slotId:${tag(o)}+':'+current.occurrence,view:View${o.name},model:${has(o.node, 'Model') ? 'current.model' : 'null'},viewInputs:{...activation.value.input,href,hrefResult${o.layout ? (has(o.node, 'provide') ? `,outlet:()=>Option.isNone(provide${o.name}(current.model,activation.value.input))?null:outlet()` : ',outlet') : ''}},toParentMessage:${has(o.node, 'Model') ? wrap(o, 'current.occurrence') : '(message:never)=>message'}})]);
};`;
  const renderChain = (chain: Owner[], leaf: string) =>
    chain.reduceRight((child, o) => `render${o.name}(model,h,()=>${child})`, leaf);
  return {
    path: flat.path,
    content:
      prelude +
      `
import { Subscription } from 'foldkit';
import type { Html,HtmlBuilder } from 'foldkit/html';
import { liftOccurrence } from 'vite-plugin-foldkit-routes/subscriptions';
${layouts.map((o) => `import * as ${o.name} from ${q(relative(o.node.relativeFile))};`).join('\n')}
${owners.map((o) => `import type {Input as ${input(o)},InputChange as ${o.name}InputChange,ViewInputs as ${o.name}ViewInputs} from ${q(relative(path.posix.join(path.posix.dirname(o.node.relativeFile), o.layout ? 'layout.gen.ts' : 'route.gen.ts')))};`).join('\n')}
${owners.map(emitDeclarations).join('\n')}
export const PageState=defineTaggedUnion({${pages.map((o) => `${tag(o)}:{...${type(o)}.fields,route:AppRoute[${tag(o)}]}`).join(',')},NotFound:{route:AppRoute.NotFound,occurrence:Schema.Int,definition:Schema.Literal(${q(definition)})},Gated:{route:AppRoute,occurrence:Schema.Literal(0),definition:Schema.Literal(${q(definition)})}});
export const Model=Schema.Struct({serial:Schema.Int,route:AppRoute,page:PageState,layouts:Schema.Struct({${layouts.map((o) => `[${field(o)}]:Runtime.searchDefault(Schema.NullOr(${type(o)}),null)`).join(',')}})});
export type Model=typeof Model.Type;
export const Message=defineMessageUnion({ChangedUrl:{url:Url.Url},${owners
        .filter((o) => has(o.node, 'Model'))
        .map((o) => `${tag(o)}:{occurrence:Schema.Int,message:${o.name}.Message}`)
        .join(',')}});
export type Message=typeof Message.Type;
export const OutMessage=${external.length ? `defineMessageUnion({${external.map((o) => `${tag(o)}:{message:${o.name}.OutMessage}`).join(',')}})` : 'Schema.Never'};
export type OutMessage=typeof OutMessage.Type;
type RequirementsOf<A>=A extends {readonly commands?:ReadonlyArray<infer C>}?C extends {readonly effect:Effect.Effect<unknown,unknown,infer R>}?R:never:never;
type AllRequirements=${requirements};
export type Requirements=Exclude<AllRequirements,typeof Urls.Service>;
type InternalReturn=Update.ReturnWithOutMessage<Model,Message,OutMessage,AllRequirements>;
export type Return=Update.ReturnWithOutMessage<Model,Message,OutMessage,Requirements>;
const finish=(result:InternalReturn):Return=>({model:result.model,...(result.outMessage===undefined?{}:{outMessage:result.outMessage}),...(result.commands===undefined?{}:{commands:result.commands.map(command=>Command.mapEffect(command,Effect.provideService(Urls,{build:buildUrl})))})});
${owners.map(emitActivation).join('\n')}
${owners.map(emitOwnerFunctions).join('\n')}
// Commands retain native metadata and declaration order. Multiple public outputs
// cannot be represented by native Return; fail rather than silently overwrite.
const append=(first:InternalReturn,next:InternalReturn):InternalReturn=>{
 if(first.outMessage!==undefined&&next.outMessage!==undefined)throw new Error('Multiple unhandled OutMessages in one lifecycle transition');
 return {model:next.model,...(first.commands===undefined&&next.commands===undefined?{}:{commands:[...(first.commands??[]),...(next.commands??[])]}),...(next.outMessage!==undefined?{outMessage:next.outMessage}:first.outMessage!==undefined?{outMessage:first.outMessage}:{})};
};
const reconcilePass=(initial:Model):InternalReturn=>{
 let result:InternalReturn={model:initial};
 ${layouts.map((o) => `result=append(result,reconcile${o.name}(result.model));`).join('\n')}
 switch(result.model.route._tag){
 ${pages.map((o) => `case ${tag(o)}:result=append(result,reconcile${o.name}(result.model));break;`).join('\n')}
 case 'NotFound':{const route=result.model.route;const current=result.model.page;if(current._tag!=='NotFound'||current.route.path!==route.path)result={...result,model:{...result.model,serial:result.model.serial+1,page:PageState.NotFound({route,occurrence:result.model.serial+1,definition:${q(definition)}})}};break;}
 }
 return result;
};
// A receiver may change an already-visited ancestor's gate/context. Iterate
// pure lifecycle work before handing any Commands to Runtime. Oscillating
// authored providers/informs are rejected, never partially activated.
const equalModel=Schema.toEquivalence(Model);
const reconcile=(initial:Model):InternalReturn=>{
 let result:InternalReturn={model:initial};
 for(let pass=0;pass<${Math.max(8, owners.length * 2 + 2)};pass++){
  const next=reconcilePass(result.model);
  const stable=equalModel(result.model,next.model);
  const previous=result.model;
  result=append(result,next);
  if(stable)return {...result,model:previous};
 }
 throw new Error('Layout lifecycle did not stabilize; check provide/inform/receiver activation cycles');
};
const equalRoute=Schema.toEquivalence(AppRoute);
const transition=(model:Model,route:AppRoute):InternalReturn=>reconcile(equalRoute(model.route,route)?model:{...model,route});
export const init=(url:Url.Url):Return=>finish(transition(Model.make({serial:0,route:AppRoute.NotFound({path:url.pathname}),page:PageState.NotFound({route:AppRoute.NotFound({path:url.pathname}),occurrence:0,definition:${q(definition)}}),layouts:{${layouts.map((o) => `[${field(o)}]:null`).join(',')}}}),parse(url)));
const updateInternal=(model:Model,message:Message):InternalReturn=>{
 switch(message._tag){case 'ChangedUrl':return transition(model,parse(message.url));
 ${owners
   .filter((o) => has(o.node, 'Model'))
   .map(
     (o) =>
       `case ${tag(o)}:{if(!(${active(o)})||${state(o)}!.occurrence!==message.occurrence)return {model};const activation=activate${o.name}(model);if(Option.isNone(activation)||${state(o)}!.scope!==activation.value.scope)return {model};const result=fold${o.name}(message.occurrence,activation.value.input)(model,message.message);return append(result,reconcile(result.model));}`,
   )
   .join('\n')}
 }
};
export const update=(model:Model,message:Message):Return=>finish(updateInternal(model,message));
// Restore is not navigation or command replay. All owners opt in; topology is
// fixed for this synchronous pass and native Commands run only after acceptance.
export type RestoreDecision=
 | {readonly _tag:'Reset';readonly reason:'UrlMismatch'|'InvalidTree'|'MissingOwnerRestore'|'TopologyChanged';readonly source?:string}
 | {readonly _tag:'Resume';readonly result:Update.Return<Model,Message,Requirements>};
export const canRestoreAt=(model:Model,url:Url.Url):boolean=>equalRoute(model.route,parse(url));
${owners.map(emitRestoreOwner).join('\n')}
const validRestoreTree=(model:Model,checkContext:boolean):boolean=>
 ${restoreChecks}&&equalRoute(model.page.route,model.route)&&
 (model.route._tag==='NotFound'?model.page._tag==='NotFound':model.page._tag!=='NotFound');
const sameRestoreTopology=(before:Model,after:Model):boolean=>
 before.serial===after.serial&&before.page._tag===after.page._tag&&before.page.occurrence===after.page.occurrence&&
 ${providerChecks}&&validRestoreTree(after,false);
export const restore=(model:Model,url:Url.Url):RestoreDecision=>{
 if(!canRestoreAt(model,url))return {_tag:'Reset',reason:'UrlMismatch'};
 if(!validRestoreTree(model,true))return {_tag:'Reset',reason:'InvalidTree'};
 ${restoreAbsent}
 let result:Update.Return<Model,Message,AllRequirements>={model};
 ${owners
   .map(
     (o) => `{const next=restoreOwner${o.name}(result.model);
 result={model:next.model,...(result.commands===undefined&&next.commands===undefined?{}:{commands:[...(result.commands??[]),...(next.commands??[])]})};
 if(!sameRestoreTopology(model,result.model))return {_tag:'Reset',reason:'TopologyChanged',source:${q(o.node.relativeFile)}};}`,
   )
   .join('\n')}
 if(!validRestoreTree(result.model,true))return {_tag:'Reset',reason:'InvalidTree'};
 return {_tag:'Resume',result:{model:result.model,...(result.commands===undefined?{}:{commands:result.commands.map(command=>Command.mapEffect(command,Effect.provideService(Urls,{build:buildUrl})))})}};
};
export const subscriptions=Subscription.aggregate(${subscriptions.join(',')});
export type SubscriptionRequirements=import('vite-plugin-foldkit-routes/subscriptions').SubscriptionRequirements<typeof subscriptions>;
${owners.map(emitRender).join('\n')}
export const view=Submodel.defineView<Model,Message>((model,h)=>{
 switch(model.route._tag){${pages.map((o) => `case ${tag(o)}:return ${renderChain(o.node.layouts.map(lookup), `render${o.name}(model,h,()=>null)`)};`).join('\n')}
 case 'NotFound':return ${renderChain(
   layouts.filter((o) => path.posix.dirname(o.node.relativeFile) === 'src/routes'),
   `h.section([],[h.h1([],['Not found']),h.p([],['No page matches this URL.'])])`,
 )};
 }
});
`,
  };
}
