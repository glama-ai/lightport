import { LAMBDA } from '../globals';
import AI302Config from './302ai';
import AI21Config from './ai21';
import AIBadgrConfig from './aibadgr';
import AnthropicConfig from './anthropic';
import AnyscaleConfig from './anyscale';
import { AzureAIInferenceAPIConfig, GithubModelAPiConfig } from './azure-ai-inference';
import AzureOpenAIConfig from './azure-openai';
import BedrockConfig from './bedrock';
import BytezConfig from './bytez';
import { cerebrasProviderAPIConfig } from './cerebras';
import CohereConfig from './cohere';
import CometAPIConfig from './cometapi';
import { DashScopeConfig } from './dashscope';
import DatabricksConfig from './databricks';
import DeepbricksConfig from './deepbricks';
import DeepInfraConfig from './deepinfra';
import DeepSeekAPIConfig from './deepseek';
import { FeatherlessAIConfig } from './featherless-ai';
import FireworksAIConfig from './fireworks-ai';
import GoogleConfig from './google';
import VertexConfig from './google-vertex-ai';
import GroqConfig from './groq';
import HuggingfaceConfig from './huggingface';
import HyperbolicConfig from './hyperbolic';
import { InferenceNetProviderConfigs } from './inference-net';
import IOIntelligenceConfig from './iointelligence';
import JinaConfig from './jina';
import KlusterAIConfig from './kluster-ai';
import KrutrimConfig from './krutrim';
import { LambdaProviderConfig } from './lambda';
import LatitudeConfig from './latitude';
import LemonfoxAIConfig from './lemonfox-ai';
import LeptonConfig from './lepton';
import LingYiConfig from './lingyi';
import MatterAIConfig from './matterai';
import MeshyConfig from './meshy';
import MilvusConfig from './milvus';
import MistralAIConfig from './mistral-ai';
import ModalConfig from './modal';
import MonsterAPIConfig from './monsterapi';
import MoonshotConfig from './moonshot';
import NCompassConfig from './ncompass';
import NebiusConfig from './nebius';
import { NextBitConfig } from './nextbit';
import NomicConfig from './nomic';
import NovitaAIConfig from './novita-ai';
import NscaleConfig from './nscale';
import OllamaAPIConfig from './ollama';
import OpenAIConfig from './openai';
import OpenrouterConfig from './openrouter';
import OracleConfig from './oracle';
import OVHcloudConfig from './ovhcloud';
import PalmAIConfig from './palm';
import PerplexityAIConfig from './perplexity-ai';
import PineconeConfig from './pinecone';
import PredibaseConfig from './predibase';
import QdrantConfig from './qdrant';
import RecraftAIConfig from './recraft-ai';
import RekaAIConfig from './reka-ai';
import ReplicateConfig from './replicate';
import SagemakerConfig from './sagemaker';
import SambaNovaConfig from './sambanova';
import SegmindConfig from './segmind';
import SiliconFlowConfig from './siliconflow';
import StabilityAIConfig from './stability-ai';
import TogetherAIConfig from './together-ai';
import Tripo3DConfig from './tripo3d';
import TritonConfig from './triton';
import { ProviderConfigs } from './types';
import { UpstageConfig } from './upstage';
import VoyageConfig from './voyage';
import WorkersAiConfig from './workers-ai';
import XAIConfig from './x-ai';
import ZAIConfig from './z-ai';
import ZhipuConfig from './zhipu';

const Providers: { [key: string]: ProviderConfigs } = {
  openai: OpenAIConfig,
  cohere: CohereConfig,
  anthropic: AnthropicConfig,
  'azure-openai': AzureOpenAIConfig,
  huggingface: HuggingfaceConfig,
  anyscale: AnyscaleConfig,
  palm: PalmAIConfig,
  'together-ai': TogetherAIConfig,
  google: GoogleConfig,
  'vertex-ai': VertexConfig,
  'perplexity-ai': PerplexityAIConfig,
  'mistral-ai': MistralAIConfig,
  deepinfra: DeepInfraConfig,
  ncompass: NCompassConfig,
  'stability-ai': StabilityAIConfig,
  nomic: NomicConfig,
  ollama: OllamaAPIConfig,
  ai21: AI21Config,
  bedrock: BedrockConfig,
  groq: GroqConfig,
  segmind: SegmindConfig,
  jina: JinaConfig,
  'fireworks-ai': FireworksAIConfig,
  'workers-ai': WorkersAiConfig,
  'reka-ai': RekaAIConfig,
  moonshot: MoonshotConfig,
  openrouter: OpenrouterConfig,
  lingyi: LingYiConfig,
  zhipu: ZhipuConfig,
  'novita-ai': NovitaAIConfig,
  monsterapi: MonsterAPIConfig,
  deepseek: DeepSeekAPIConfig,
  predibase: PredibaseConfig,
  triton: TritonConfig,
  voyage: VoyageConfig,
  'azure-ai': AzureAIInferenceAPIConfig,
  github: GithubModelAPiConfig,
  deepbricks: DeepbricksConfig,
  siliconflow: SiliconFlowConfig,
  cerebras: cerebrasProviderAPIConfig,
  'inference-net': InferenceNetProviderConfigs,
  sambanova: SambaNovaConfig,
  'lemonfox-ai': LemonfoxAIConfig,
  upstage: UpstageConfig,
  [LAMBDA]: LambdaProviderConfig,
  dashscope: DashScopeConfig,
  'x-ai': XAIConfig,
  qdrant: QdrantConfig,
  sagemaker: SagemakerConfig,
  nebius: NebiusConfig,
  'recraft-ai': RecraftAIConfig,
  milvus: MilvusConfig,
  replicate: ReplicateConfig,
  lepton: LeptonConfig,
  'kluster-ai': KlusterAIConfig,
  nscale: NscaleConfig,
  hyperbolic: HyperbolicConfig,
  bytez: BytezConfig,
  'featherless-ai': FeatherlessAIConfig,
  krutrim: KrutrimConfig,
  '302ai': AI302Config,
  cometapi: CometAPIConfig,
  matterai: MatterAIConfig,
  meshy: MeshyConfig,
  nextbit: NextBitConfig,
  tripo3d: Tripo3DConfig,
  modal: ModalConfig,
  'z-ai': ZAIConfig,
  oracle: OracleConfig,
  iointelligence: IOIntelligenceConfig,
  aibadgr: AIBadgrConfig,
  ovhcloud: OVHcloudConfig,
  latitude: LatitudeConfig,
  databricks: DatabricksConfig,
  pinecone: PineconeConfig,
};

export default Providers;
