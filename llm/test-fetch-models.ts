import { defaultProviders, getProvidersWithLatestModels } from './ModelDefaults';
import { refreshProviderModels } from './fetchModels';
import { Provider, Model } from './Interfaces';

async function testFetchModels() {
  console.log('🚀 Testing model fetching for all providers...\n');
  
  // Test with default providers (no API keys)
  console.log('📋 Testing with default providers (no API keys):');
  console.log('=' .repeat(60));

  const fetchProviders = ['OpenAI', 'Anthropic'];

  const filteredProviders = defaultProviders.filter(provider => fetchProviders.includes(provider.name));
  
  for (const provider of filteredProviders) {
    console.log(`\n🔍 Testing ${provider.name}:`);
    console.log(`   Endpoint: ${provider.apiEndpoint || 'Not set'}`);
    console.log(`   API Key: ${provider.apiKey ? '***set***' : 'Not set'}`);
    
    try {
      const updatedProviders = await refreshProviderModels([provider]);
      const updatedProvider = updatedProviders[0];
      
      if (updatedProvider.models && updatedProvider.models.length > 0) {
        console.log(`   ✅ Found ${updatedProvider.models.length} models:`);
        
        // Show first 5 models as examples
        const modelsToShow = updatedProvider.models.slice(0, 5);
        modelsToShow.forEach((model: Model, idx: number) => {
          console.log(`      ${idx + 1}. ${model.name}`);
          if (model.max_tokens) {
            console.log(`         Max tokens: ${model.max_tokens}`);
          }
        });
        
        if (updatedProvider.models.length > 5) {
          console.log(`      ... and ${updatedProvider.models.length - 5} more models`);
        }
      } else {
        console.log(`   ⚠️  No models found`);
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /*
  try {
    const providers = await getProvidersWithLatestModels();
    console.log(`✅ Successfully fetched models for ${providers.length} providers`);
    
    let totalModels = 0;
    providers.forEach(provider => {
      const modelCount = provider.models?.length || 0;
      totalModels += modelCount;
      console.log(`   ${provider.name}: ${modelCount} models`);
    });
    
    console.log(`\n📊 Total models across all providers: ${totalModels}`);
  } catch (error) {
    console.log(`❌ Error in getProvidersWithLatestModels: ${error instanceof Error ? error.message : String(error)}`);
  }
    */
  
  // // Test custom providers
  // console.log('\n\n🛠️  Testing custom provider configurations:');
  // console.log('=' .repeat(60));
  
  // const customProviders: Provider[] = [
  //   {
  //     id: 'custom_openai',
  //     name: 'OpenAI',
  //     apiEndpoint: 'https://api.openai.com/v1/',
  //     apiKey: process.env.OPENAI_API_KEY || 'test-key',
  //     models: []
  //   },
  // ];
  
  // for (const provider of customProviders) {
  //   console.log(`\n🔍 Testing ${provider.name} (${provider.id}):`);
  //   console.log(`   Endpoint: ${provider.apiEndpoint}`);
    
  //   try {
  //     const updatedProviders = await refreshProviderModels([provider]);
  //     const updatedProvider = updatedProviders[0];
      
  //     if (updatedProvider.models && updatedProvider.models.length > 0) {
  //       console.log(`   ✅ Found ${updatedProvider.models.length} models`);
  //       updatedProvider.models.slice(0, 3).forEach((model: Model, idx: number) => {
  //         console.log(`      ${idx + 1}. ${model.name}`);
  //       });
  //       if (updatedProvider.models.length > 3) {
  //         console.log(`      ... and ${updatedProvider.models.length - 3} more`);
  //       }
  //     } else {
  //       console.log(`   ⚠️  No models found or service unavailable`);
  //     }
  //   } catch (error) {
  //     console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
  //   }
  // }
  
  console.log('\n🏁 Model fetching test completed!');
  console.log('\nTo use API keys, set environment variables:');
  console.log('   OPENAI_API_KEY=your_key');
  console.log('   ANTHROPIC_API_KEY=your_key');
  console.log('   OPENROUTER_API_KEY=your_key');
  console.log('   GROQ_API_KEY=your_key');
}

// Run the test
if (require.main === module) {
  testFetchModels().catch(console.error);
}

export { testFetchModels };