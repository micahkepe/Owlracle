import { kv } from '@vercel/kv'
import prisma from '@/lib/prisma'
import { createClient } from "@supabase/supabase-js";
import { codeBlock, oneLine } from 'common-tags'
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { 
  Configuration, 
  OpenAIApi,
  ChatCompletionRequestMessage
} from 'openai-edge'
import GPT3Tokenizer from 'gpt3-tokenizer'
import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

const openaiKey = process.env.OPENAI_API_KEY
if (!openaiKey) throw new Error(`Expected env var OPENAI_API_KEY`)
const configuration = new Configuration({apiKey: openaiKey})
const openai = new OpenAIApi(configuration)
const embeddingFn = new OpenAIEmbeddings();

const supabaseUrl = process.env.SUPABASE_URL
if (!supabaseUrl) throw new Error(`Expected env var SUPABASE_URL`)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY
if (!supabaseServiceKey) throw new Error(`Expected env var SUPABASE_SERVICE_KEY`)


const openAiAPIcall = async (prompt: string): Promise<string> => {

  const chatMessage : ChatCompletionRequestMessage = {
    role: 'user',
    content: prompt,
  }

  const response = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: [chatMessage],
    temperature: 0.7,
  })

  if (! response.ok) {
    const error = await response.json()
    console.log('openAiAPIcall: Failed to generate completion', error)
    throw new Error('openAiAPIcall: Failed to generate completion')
  }

  return (await response.json()).choices[0].message.content
}

const getBetterQuery = async (messages: ChatCompletionRequestMessage[]): Promise<string> => {

  const query = messages[messages.length-1].content
  let sanitizedQuery = query!.trim()

  // Make sure query contains 'Computatinoal thinking' rather than 'COMP 140'
  sanitizedQuery = await substite(sanitizedQuery)
  // console.log("substitute:", sanitizedQuery)

  if (messages.length == 1)
      return sanitizedQuery

  const message_str: string = messages
    .slice(messages.length < 5 ? 0 : -5, -1)
    .map(conv => `${conv['role']}: ${conv['content']}`)
    .join('\n')
  
  const prompt = codeBlock`
    I have the following conversation history between user and LLM:
    ${message_str}

    ${oneLine`
      Based on this conversation history,
      I want you to make the following user
      prompt more complete by removing refereces.
      For example, if user asks "What is his
      name?" Then you should figure out what
      does "his" refer to and give me the more
      complete version of user prompt.
      Don't leave any reference in your eventual answer.
      If the user prompt is about you i.e. the virtual assistant, no need to change it.
    `}

    This is the user prompt:
    ${sanitizedQuery}
  `

  return openAiAPIcall(prompt)
}

// substite "... Comp 140 ..." -> "Computational thinking"
const substite = async (query: string): Promise<string> => {
  const matches = findAllPatterns(query)

  // console.log("matches", matches)

  if (matches.length == 0)
    return query

  const formatMatches = format(matches)

  // console.log("formatMatches", formatMatches)

  const replace = await getSubs(formatMatches)

  // console.log("replace", replace)

  const final_query = subQuery(query, replace)

  // console.log("final_query", replace)

  return final_query.trim()
  


  function findAllPatterns(sentence: string): string[] {
    const pattern = /\b[A-Za-z]{4}\s*\d{3}\b/gi
    const matches = sentence.match(pattern);

    return matches ? matches : [];
  }
  function format(matches: string[]): string[] {
    let formattedMatches: string[] = [];
    const letterPattern = /[A-Za-z]{4}/i;
    const numberPattern = /\d{3}/;

    for (let match of matches) {
        let letters = match.match(letterPattern);
        let numbers = match.match(numberPattern);

        if (letters && numbers) {
            let formattedMatch = `${letters[0].toUpperCase()} ${numbers[0]}`;
            formattedMatches.push(formattedMatch);
        }
    }

    return formattedMatches;
  }
  async function getSubs(matches: string[]): Promise<string[]> {
    let replace = []

    const subResults = await prisma.courseCatalog.findMany({
      where: {
        OR: matches.map((match) => ({
          cNum: match.split(' ')[1],
          cField: match.split(' ')[0],
        })),
      },
      select: {
        cField: true,
        cNum: true,
        course_name: true
      },
    })

    for (let match of matches) {
      let [cField, cNum] = match.split(' ');
      const course_name = subResults.find(e => e.cField == cField && e.cNum == cNum)?.course_name
      replace.push(course_name ? `Course(${cField} ${cNum}/${course_name})` : `${cField} ${cNum}`)
    }

    return replace
  }
  function subQuery(query: string, subResults: string[]): string {
    function replaceSubstring(query: string, startPos: number, endPos: number, subResult: string): string {
        return query.slice(0, startPos) + subResult + query.slice(endPos);
    }

    const pattern = /\b[A-Za-z]{4}\s*\d{3}\b/gi
    let matches = Array.from(query.matchAll(pattern));

    let matchPositions: Array<[string, [number, number]]> = [];
    for (let match of matches) {
        let startPos = match.index!;
        let endPos = match.index! + match[0].length;
        matchPositions.push([match[0], [startPos, endPos]]);
    }

    matchPositions.reverse();
    subResults.reverse();

    for (let i = 0; i < matchPositions.length; i++) {
        let startPos = matchPositions[i][1][0];
        let endPos = matchPositions[i][1][1];
        query = replaceSubstring(query, startPos, endPos, subResults[i]);
    }

    return query;
  }
}

const enoughContext = async (currentContext: string, userQuery: string): Promise<boolean> => {

  // console.log('currentContext:', currentContext)
  // console.log('userQuery:', userQuery)

  const prompt = codeBlock`
    I have the following context:
    ${currentContext}

    ${oneLine`
      I want you to determine if the context above is
      sufficient to answer the following user prompt.
      To be considered sufficient, the context needs to be able to DIRECTLY answer the prompt.
      If user asked about courses/classes, the context needs to have exact course names (e.g. COMP 140, HIST 200)
      to be considered sufficient.
      If it's sufficient, respond "yes" without explanation.
    `}

    This is the user prompt:
    ${userQuery}
  `

  const response = (await openAiAPIcall(prompt)).toLowerCase()
  // console.log("response:", response, response.includes('yes'))
  return response.includes('yes')
}

interface RelevantDBResult {
  // A dictionary indicating if the db is needed
  dbs: Record<string, boolean>
  // How many databases are needed
  dbNum: number
}

const getRelaventDB = async (query: string): Promise<RelevantDBResult> => {
  const prompt = codeBlock`
    ${oneLine`
      You are given following Rice University databases:
      1. Courses
      2. Events
      3. Organizations
      4. Faculties
      You will be given a question.
      Your job is to give all the relevant databases that are necessary to answer the question.
      Generally, more database and more information is better.
      Respond in this format without any explanation, only the name of the database:
      database_1
      database_2
      ...
    `}

    This is the question:
    ${query}
  `

  const relaventDBs : string = (await openAiAPIcall(prompt)).toLowerCase()
  // console.log('relaventDBs:', relaventDBs)

  let dbs: Record<string, boolean> = {
    'courses': relaventDBs.includes('courses'),
    'events': relaventDBs.includes('events'),
    'faculties': relaventDBs.includes('faculties'),
    'organizations': relaventDBs.includes('organizations'),
  };
  
  let dbNum = Object.values(dbs).filter(value => value === true).length
  
  return {
      dbs,
      dbNum,
  }
}

export async function POST(req: Request) {
  const json = await req.json()
  const { messages, previewToken } = json
  const userId = (await auth())?.user.id

  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  if (previewToken) {
    configuration.apiKey = previewToken
  }

  // Make query better for vectorDB: reference free
  const betterQuery = await getBetterQuery(messages)
  console.log("Better query:", betterQuery)

  // Create embedding for query
  const queryEmbedding = await embeddingFn.embedQuery(betterQuery.replaceAll('\n', ' '));

  // Connect to vector DB
  const supabaseClient = createClient(
    supabaseUrl!, 
    supabaseServiceKey!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  
  // Similarity search
  let combinedPageSections = []
  const { error: matchError, data: pageSections } = await supabaseClient.rpc(
    `match_faq`,
    {
      query_embedding: queryEmbedding,
      match_threshold: 0.78,
      match_count: 2,
    }
  )
  if (matchError) {
    console.log('Failed to match page sections', matchError)
    throw new Error(`Failed to match page sections`)
  }
  combinedPageSections.push(...pageSections)
  // console.log("combinedPageSections:", combinedPageSections)

  // Check if current contexts are already enough
  const isSufficient = await enoughContext(combinedPageSections.map(obj => obj.content).join(''), betterQuery)
  console.log('isSufficient:', isSufficient)
  if (! isSufficient) {
    
    // Delete previously stored contexts
    combinedPageSections = []

    // Infer which vectorDB(s) are needed
    const { dbs, dbNum } = await getRelaventDB(betterQuery)
    console.log("getRelaventDB:", dbs, dbNum)

    for (const key in dbs) {
      if (dbs[key]) {
        const { error: matchError, data: pageSections } = await supabaseClient.rpc(
          `match_${key}`,
          {
            query_embedding: queryEmbedding,
            match_count: Math.floor(10 / dbNum),
          }
        )
        if (matchError) {
          console.log('Failed to match page sections', matchError)
          throw new Error(`Failed to match page sections`)
        }
  
        combinedPageSections.push(...pageSections)
      }
    }
    // console.log('Retreival successful:', combinedPageSections)
  }


  // Generate contexts
  const tokenizer = new GPT3Tokenizer({ type: 'gpt3' })
  let tokenCount = 0
  let contextText = ''

  for (let i = 0; i < combinedPageSections.length; i++) {
    const pageSection = combinedPageSections[i]
    const content = pageSection.content
    const encoded = tokenizer.encode(content)
    tokenCount += encoded.text.length

    if (tokenCount >= 1500) {
      break
    }

    contextText += `${content.trim()}\n---\n`
  }
  // console.log('tokenCount:', tokenCount)

  const prompt = codeBlock`
    Imagine yourself as the virtual assistant for Rice Univ. students created by Nice Organization,
    that can provide information on course, faculty, event, organization.
    In addition, you can update your knowledge base through learning independent and from Rice students.

    Context sections:
    ${contextText}

    ${oneLine`
      Use the context above, answer the question below concisely and accurately.
      Include in your answer as many relevant information from context as possible.
      If you are unsure and the answer is not explicitly written in the context, say
      "Sorry, I don't know how to help with that. I have kept in mind to learn this next time we meet."
      Try to make your response concise and informative by summarizing the information instead of completely copying.
    `}

    Question: """
    Provide relavant URL references if possible: ${betterQuery}
    """

    Answer as markdown.
  `
  // console.log('prompt:', prompt)

  const chatMessage : ChatCompletionRequestMessage = {
    role: 'user',
    content: prompt,
  }

  const response = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: [chatMessage],
    max_tokens: 512,
    temperature: 0.7,
    stream: true,
  })

  if (!response.ok) {
    const error = await response.json()
    console.log('Failed to generate completion', error)
    throw new Error('Failed to generate completion')
  }

  const stream = OpenAIStream(response, {
    async onCompletion(completion) {
      const title = json.messages[0].content.substring(0, 100)
      const id = json.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messages,
          {
            content: completion,
            role: 'assistant'
          }
        ]
      }
      await kv.hmset(`chat:${id}`, payload)
      await kv.zadd(`user:chat:${userId}`, {
        score: createdAt,
        member: `chat:${id}`
      })
    }
  })

  return new StreamingTextResponse(stream)
}
